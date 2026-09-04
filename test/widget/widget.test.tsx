// test/widget/widget.test.tsx — ChatWidget (src/widget) sob jsdom.
//
// Estratégia: componente real renderizado com testing-library; a porta `RealtimeHandle`
// é um fake que captura onEvent/onStatus (DI — o widget não conhece Supabase), e
// `global.fetch` é um mock que devolve exatamente os formatos de `createChatRoutes`
// (Task 8): GET → {session:{code,status,visitorName},messages}, POST sem token →
// {session:{...,realtimeToken},messages}, POST com token → {message}.
//
// Cobertura (matriz da task):
//  (a) abrir → preencher form → enviar → msg otimista + POST /api/chat com o corpo;
//  (b) msg via realtime.subscribe com painel fechado → badge +1;
//  (c) fallback: onStatus("closed") → polling ~5s e msg nova aparece;
//  (d) honeypot preenchido → nenhum POST /api/chat;
//  (e) ESC fecha o painel e devolve o foco ao balão;
//  (f) sessão "closed"/"failed" → composer desabilitado + botão "nova conversa" que
//      limpa o storage e volta ao pré-chat form (sessão "active" continua compondo).
// Mais: paridade de chaves i18n e limpeza do storage em 404.

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ChatWidget } from "../../src/widget/chat-widget";
import { WIDGET_KEYS, en, es, pt } from "../../src/widget/i18n";
import type { RealtimeHandle } from "../../src/bridge/types";
import type { ChatEvent, ChatMessage, ChatSessionStatus } from "../../src/types";

// ─── fakes ────────────────────────────────────────────────────────────────────

interface FakeRealtime {
  handle: RealtimeHandle;
  subscribed: string[];
  unsubscribed: string[];
  emit(event: ChatEvent): void;
  status(s: "open" | "closed"): void;
}

function createFakeRealtime(): FakeRealtime {
  const subscribed: string[] = [];
  const unsubscribed: string[] = [];
  let onEvent: ((e: ChatEvent) => void) | null = null;
  let onStatus: ((s: "open" | "closed") => void) | null = null;

  const handle: RealtimeHandle = {
    subscribe(token, ev, st) {
      subscribed.push(token);
      onEvent = ev;
      onStatus = st ?? null;
      return () => {
        unsubscribed.push(token);
        onEvent = null;
        onStatus = null;
      };
    },
  };

  return {
    handle,
    subscribed,
    unsubscribed,
    emit: (e) => {
      onEvent?.(e);
    },
    status: (s) => {
      onStatus?.(s);
    },
  };
}

function msg(
  id: string,
  direction: ChatMessage["direction"],
  body: string,
  status: ChatMessage["status"] = "sent",
  createdAt = "2025-03-01T10:00:00.000Z",
): ChatMessage {
  return { id, sessionId: "sess-1", direction, body, status, waMessageId: null, createdAt };
}

interface FetchCall {
  url: string;
  method: string;
  body: Record<string, unknown> | null;
}

interface Responder {
  status: number;
  json: unknown;
}

/**
 * Mock de fetch fiel ao contrato das rotas: registra {url, method, body} e delega a
 * resposta ao handler. Devolve um objeto-Response mínimo (só status/ok/json são
 * consumidos pelo widget) para não depender do impl de fetch do jsdom.
 */
function createFetchMock(respond: (url: URL, call: FetchCall) => Responder) {
  const calls: FetchCall[] = [];
  let handler = respond;
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://widget.test");
    const call: FetchCall = {
      url: String(input),
      method: (init?.method ?? "GET").toUpperCase(),
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
    };
    calls.push(call);
    const res = handler(url, call);
    return {
      status: res.status,
      ok: res.status >= 200 && res.status < 300,
      json: async () => res.json,
    } as unknown as Response;
  });
  return {
    fn,
    calls,
    /** Troca o handler em um teste específico sem recriar o mock (o widget guarda `fetch` por chamada). */
    setResponder(next: (url: URL, call: FetchCall) => Responder): void {
      handler = next;
    },
  };
}

// Respostas padrão do servidor nos testes.
const HISTORY_MSG = msg("m-hist", "owner", "Olá! Como podemos ajudar?");
const POLL_MSG = msg("m-poll", "owner", "Já estamos te atendendo por aqui.");
const RT_TOKEN = "t1";

function defaultResponder(url: URL, call: FetchCall): Responder {
  if (call.method === "GET") {
    if (url.searchParams.has("after")) {
      return { status: 200, json: { session: { code: "A3F2", status: "active", visitorName: "João" }, messages: [POLL_MSG] } };
    }
    return { status: 200, json: { session: { code: "A3F2", status: "active", visitorName: "João" }, messages: [HISTORY_MSG] } };
  }
  // POST sem token → abre sessão; com token → envia mensagem.
  if (typeof call.body?.["token"] === "string" && call.body["token"] !== "") {
    return {
      status: 200,
      json: { message: msg("m-send", "visitor", String(call.body["message"]), "sent") },
    };
  }
  return {
    status: 200,
    json: {
      session: { code: "A3F2", status: "active", realtimeToken: RT_TOKEN, visitorName: String(call.body?.["name"] ?? "") },
      messages: [msg("m-start", "visitor", String(call.body?.["message"] ?? ""), "sent")],
    },
  };
}

/** GET devolve a sessão com `status` dado (o resto do contrato é o padrão). */
function sessionResponder(status: ChatSessionStatus): (url: URL, call: FetchCall) => Responder {
  return (url, call) => {
    if (call.method === "GET") {
      return {
        status: 200,
        json: { session: { code: "A3F2", status, visitorName: "João" }, messages: [HISTORY_MSG] },
      };
    }
    return defaultResponder(url, call);
  };
}

function renderWidget(rt: FakeRealtime) {
  return render(
    <ChatWidget
      endpoint="/api/chat"
      locale="pt"
      welcome="Oi! Como podemos ajudar?"
      projectName="Aulivra"
      realtime={rt.handle}
    />,
  );
}

// Preenche o pré-chat form e clica em Enviar (fluxo feliz).
async function submitForm(honeypotValue = ""): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /abrir chat/i }));
  fireEvent.change(screen.getByLabelText(/nome/i), { target: { value: "João" } });
  fireEvent.change(screen.getByLabelText(/whatsapp/i), { target: { value: "(11) 99999-8888" } });
  fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "Olá!" } });
  const hp = document.querySelector<HTMLInputElement>('input[name="website"]');
  expect(hp).not.toBeNull();
  fireEvent.change(hp!, { target: { value: honeypotValue } });
  fireEvent.click(screen.getByRole("button", { name: /enviar/i }));
}

// ─── setup/teardown ───────────────────────────────────────────────────────────

/**
 * Storage em memória. Necessário porque o Node >=22 define um accessor global
 * `localStorage` (webstorage experimental) que, sem `--localstorage-file`, devolve um
 * objeto sem métodos — e o ambiente jsdom do vitest faz `window === globalThis`,
 * sombreando o Storage real do jsdom. Em browser isto é nativo; aqui é o fake padrão.
 */
function createStorageFake(): Storage {
  const map = new Map<string, string>();
  return {
    get length(): number {
      return map.size;
    },
    clear(): void {
      map.clear();
    },
    getItem(key: string): string | null {
      return map.get(key) ?? null;
    },
    key(index: number): string | null {
      return Array.from(map.keys())[index] ?? null;
    },
    removeItem(key: string): void {
      map.delete(key);
    },
    setItem(key: string, value: string): void {
      map.set(key, String(value));
    },
  };
}

let fetchMock: ReturnType<typeof createFetchMock>;
let originalLocalStorage: PropertyDescriptor | undefined;

beforeEach(() => {
  originalLocalStorage = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", {
    value: createStorageFake(),
    configurable: true,
    writable: true,
  });
  fetchMock = createFetchMock(defaultResponder);
  vi.stubGlobal("fetch", fetchMock.fn);
});

afterEach(() => {
  if (originalLocalStorage !== undefined) {
    Object.defineProperty(window, "localStorage", originalLocalStorage);
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ─── i18n ─────────────────────────────────────────────────────────────────────

describe("i18n", () => {
  it("pt tem todas as chaves obrigatórias com texto não vazio", () => {
    const required = [
      "openChat", "close", "name", "phone", "message", "send", "sending",
      "welcomeNotice", "privacyNote", "invalidPhone", "sendError", "retry",
      "sessionClosed", "newConversation", "poweredBy", "typing", "loading",
    ] as const;
    for (const key of required) {
      expect(WIDGET_KEYS).toContain(key);
      expect(pt[key].trim().length).toBeGreaterThan(0);
    }
    expect(WIDGET_KEYS).toHaveLength(required.length);
  });

  it("en e es têm exatamente o mesmo conjunto de chaves que pt", () => {
    const keys = [...WIDGET_KEYS].sort();
    expect(Object.keys(en).sort()).toEqual(keys);
    expect(Object.keys(es).sort()).toEqual(keys);
    for (const key of WIDGET_KEYS) {
      expect(en[key].trim().length).toBeGreaterThan(0);
      expect(es[key].trim().length).toBeGreaterThan(0);
    }
  });

  it("t() resolve locale, override e fallback", async () => {
    const { t } = await import("../../src/widget/i18n");
    expect(t("pt", "send")).toBe("Enviar");
    expect(t("en", "send")).toBe("Send");
    expect(t("es", "send")).toBe("Enviar");
    expect(t("pt", "send", { send: "Mandar" })).toBe("Mandar");
  });
});

// ─── styles ───────────────────────────────────────────────────────────────────

describe("styles", () => {
  it("styles.css espelha o CSS injetado (sem drift entre arquivo publicado e runtime)", async () => {
    const { readFileSync } = await import("node:fs");
    const { WIDGET_CSS } = await import("../../src/widget/styles");
    const file = readFileSync("src/widget/styles.css", "utf8");
    const norm = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\s+/g, " ").trim();
    expect(norm(file)).toBe(norm(WIDGET_CSS));
    expect(norm(file)).toContain(".ecw-bubble--visitor");
    expect(norm(file)).toContain("--ecw-accent");
  });

  it("injectWidgetStyles é idempotente: um único <style id=\"ecw-styles\">", async () => {
    const { injectWidgetStyles } = await import("../../src/widget/styles");
    injectWidgetStyles();
    injectWidgetStyles();
    const tags = document.querySelectorAll('style[id="ecw-styles"]');
    expect(tags).toHaveLength(1);
    expect(tags[0]!.textContent).toContain(".ecw-panel");
  });
});

// ─── (a) fluxo form → chat ────────────────────────────────────────────────────

describe("fluxo pré-chat", () => {
  it("(a) abre, preenche, envia → mensagem otimista aparece + POST /api/chat com o form", async () => {
    const rt = createFakeRealtime();
    renderWidget(rt);

    // painel fechado: nada de form/dialog
    expect(screen.queryByRole("dialog")).toBeNull();

    await submitForm();

    // mensagem do visitante aparece imediatamente (otimista) e o code no header
    await waitFor(() => expect(screen.getByText("Olá!")).toBeInTheDocument());
    expect(screen.getByText(/A3F2/)).toBeInTheDocument();
    expect(screen.getByText("Aulivra")).toBeInTheDocument();

    const post = fetchMock.calls.find((c) => c.method === "POST");
    expect(post).toBeDefined();
    expect(post!.url).toContain("/api/chat");
    expect(post!.body).toMatchObject({ name: "João", message: "Olá!", honeypot: "" });
    expect(String(post!.body!["phone"]).replace(/\D/g, "")).toBe("11999998888");

    // sessão persistida + assinatura realtime com o token
    expect(JSON.parse(window.localStorage.getItem("ecw:session") ?? "{}")).toMatchObject({ token: RT_TOKEN, code: "A3F2" });
    await waitFor(() => expect(rt.subscribed).toContain(RT_TOKEN));
  });

  it("máscara parcial de telefone e validação de ≥10 dígitos", async () => {
    const rt = createFakeRealtime();
    renderWidget(rt);
    fireEvent.click(screen.getByRole("button", { name: /abrir chat/i }));

    const phone = screen.getByLabelText(/whatsapp/i) as HTMLInputElement;
    fireEvent.change(phone, { target: { value: "113" } });
    expect(phone.value).toBe("(11) 3");

    // incompleto → enviar desabilitado, nenhum POST
    fireEvent.change(screen.getByLabelText(/nome/i), { target: { value: "João" } });
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "Oi" } });
    const sendBtn = screen.getByRole("button", { name: /enviar/i }) as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);

    // 9 dígitos ainda é inválido
    fireEvent.change(phone, { target: { value: "119999988" } });
    expect(phone.value).toBe("(11) 99999-88");
    expect(sendBtn.disabled).toBe(true);

    // 11 dígitos → habilita e envia
    fireEvent.change(phone, { target: { value: "(11) 99999-8888" } });
    expect(sendBtn.disabled).toBe(false);
    fireEvent.click(sendBtn);
    await waitFor(() => expect(screen.getByText("Oi")).toBeInTheDocument());
    expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(true);
  });

  it("composer: durante o envio o botão mostra spinner (não fica sem ícone)", async () => {
    const rt = createFakeRealtime();
    renderWidget(rt);
    await submitForm();
    await waitFor(() => expect(rt.subscribed).toContain(RT_TOKEN));

    // Pendura o POST: sending permanece true e dá tempo de inspecionar o botão.
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "teste" } });
    fireEvent.click(screen.getByRole("button", { name: /enviar/i }));

    const busy = (await screen.findByRole("button", { name: /enviando/i })) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    expect(busy.querySelector(".ecw-spinner")).not.toBeNull();
  });

  it("typing some na hora quando o input fica vazio (sem 'digitando' fantasma)", async () => {
    const rt = createFakeRealtime();
    renderWidget(rt);
    await submitForm();
    await waitFor(() => expect(rt.subscribed).toContain(RT_TOKEN));

    // resposta do bot chega e encerra o handoff: nenhum indicador ativo antes do teste
    act(() => {
      rt.emit({ type: "message", message: msg("m-reply", "owner", "Olá, tudo bem?") });
    });
    await waitFor(() => expect(screen.getByText("Olá, tudo bem?")).toBeInTheDocument(), { timeout: 3000 });
    await waitFor(() => expect(document.querySelectorAll(".ecw-typing")).toHaveLength(0));

    const input = screen.getByLabelText(/mensagem/i);
    // digita → pontinhos locais aparecem
    fireEvent.change(input, { target: { value: "o" } });
    expect(document.querySelectorAll(".ecw-typing").length).toBeGreaterThan(0);
    // apaga tudo → pontinhos somem IMEDIATAMENTE (sem esperar o idle de 4s)
    fireEvent.change(input, { target: { value: "" } });
    expect(document.querySelectorAll(".ecw-typing")).toHaveLength(0);
  });

  it("restauração: enquanto o GET de histórico está em voo mostra skeleton, não o form", async () => {
    const rt = createFakeRealtime();
    window.localStorage.setItem("ecw:session", JSON.stringify({ token: RT_TOKEN, code: "A3F2" }));
    // Resposta pendurada: o estado "restoring" fica true e dá tempo de inspecionar.
    fetchMock.fn.mockImplementation(
      () => new Promise(() => {}) as unknown as Promise<Response>,
    );

    renderWidget(rt);
    fireEvent.click(screen.getByRole("button", { name: /abrir chat/i }));

    // Skeleton visível; o form de dados NÃO aparece durante a restauração.
    await waitFor(() => expect(document.querySelector(".ecw-skeleton")).not.toBeNull());
    expect(screen.queryByLabelText(/nome/i)).toBeNull();

    // (o teste termina aqui; o fetch pendurado é descartado no unmount)
  });

  it("handoff: após enviar, os pontinhos continuam ('preparando resposta') até a resposta chegar", async () => {    const rt = createFakeRealtime();
    renderWidget(rt);
    await submitForm();
    await waitFor(() => expect(rt.subscribed).toContain(RT_TOKEN));
    await waitFor(() => expect(screen.getByText("Olá!")).toBeInTheDocument());

    // Envia a segunda mensagem: os pontinhos NÃO cortam com o input vazio…
    fireEvent.change(screen.getByLabelText(/mensagem/i), { target: { value: "tem desconto?" } });
    fireEvent.click(screen.getByRole("button", { name: /enviar/i }));
    await waitFor(() => expect(screen.getByText("tem desconto?")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getAllByRole("status").some((el) => el.classList.contains("ecw-typing"))).toBe(true),
    );

    // …e param quando a resposta renderiza (realtime → typing simulado → mensagem).
    act(() => {
      rt.emit({ type: "message", message: msg("m-reply", "owner", "Claro, 10%!") });
    });
    await waitFor(() => expect(screen.getByText("Claro, 10%!")).toBeInTheDocument(), { timeout: 3000 });
    await waitFor(() =>
      expect(screen.queryAllByRole("status").every((el) => !el.classList.contains("ecw-typing"))).toBe(true),
    );
  });
});

// ─── (b) realtime + badge ─────────────────────────────────────────────────────

describe("tempo real", () => {
  it("(b) mensagem via subscribe com painel fechado → badge +1; abrir limpa o badge", async () => {
    const rt = createFakeRealtime();
    renderWidget(rt);
    await submitForm();
    await waitFor(() => expect(rt.subscribed).toContain(RT_TOKEN));

    // fecha o painel
    fireEvent.click(screen.getByRole("button", { name: /fechar/i }));
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => {
      rt.emit({ type: "message", message: msg("m-rt", "owner", "Mensagem do atendente") });
    });

    // mensagem chega após o "digitando…" simulado (delay) → badge aparece em seguida
    await waitFor(() => expect(screen.getByText("1")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText("Mensagem do atendente")).toBeNull();

    // reabre → mensagem aparece, badge some
    fireEvent.click(screen.getByRole("button", { name: /abrir chat/i }));
    await waitFor(() => expect(screen.getByText("Mensagem do atendente")).toBeInTheDocument());
    expect(screen.queryByText("1")).toBeNull();
  });

  it("mensagem via realtime com painel aberto aparece direto na lista", async () => {
    const rt = createFakeRealtime();
    renderWidget(rt);
    await submitForm();
    await waitFor(() => expect(rt.subscribed).toContain(RT_TOKEN));

    act(() => {
      rt.emit({ type: "message", message: msg("m-rt2", "owner", "Olá, João!") });
    });
    // mensagem recebida aparece após o "digitando…" simulado (delay)
    await waitFor(() => expect(screen.getByText("Olá, João!")).toBeInTheDocument(), { timeout: 3000 });
    expect(screen.queryByText("1")).toBeNull();
  });
});

// ─── (c) fallback polling ─────────────────────────────────────────────────────

describe("fallback de transporte", () => {
  it("(c) onStatus('closed') → polling após ~5s e mensagem nova aparece", async () => {
    const rt = createFakeRealtime();
    window.localStorage.setItem("ecw:session", JSON.stringify({ token: RT_TOKEN, code: "A3F2" }));

    renderWidget(rt);

    // sessão existente → GET no mount com o token → subscribe
    await waitFor(() => expect(rt.subscribed).toContain(RT_TOKEN));
    const get = fetchMock.calls.find((c) => c.method === "GET");
    expect(get?.url).toContain("token=t1");

    // painel aberto mostra o histórico restaurado
    fireEvent.click(screen.getByRole("button", { name: /abrir chat/i }));
    expect(screen.getByText(HISTORY_MSG.body)).toBeInTheDocument();

    const getsBefore = fetchMock.calls.filter((c) => c.method === "GET").length;

    // só agora os timers viram fake (waitFor não funciona bem com timers fake)
    vi.useFakeTimers();
    act(() => {
      rt.status("closed");
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_200);
    });
    vi.useRealTimers();

    await waitFor(() =>
      expect(fetchMock.calls.filter((c) => c.method === "GET").length).toBeGreaterThan(getsBefore),
    );
    const poll = fetchMock.calls.filter((c) => c.method === "GET").at(-1)!;
    expect(poll.url).toContain("token=t1");
    expect(poll.url).toContain("after=");
    await waitFor(() => expect(screen.getByText(POLL_MSG.body)).toBeInTheDocument());
  });

  it("404 no GET inicial limpa o storage e volta ao form", async () => {
    const rt = createFakeRealtime();
    window.localStorage.setItem("ecw:session", JSON.stringify({ token: "t-morto", code: "A3F2" }));
    fetchMock.fn.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const call: FetchCall = {
        url: String(input),
        method: (init?.method ?? "GET").toUpperCase(),
        body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null,
      };
      fetchMock.calls.push(call);
      return { status: 404, ok: false, json: async () => ({ error: "session_not_found" }) } as unknown as Response;
    });

    renderWidget(rt);

    await waitFor(() => expect(window.localStorage.getItem("ecw:session")).toBeNull());
    expect(rt.subscribed).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: /abrir chat/i }));
    expect(screen.getByLabelText(/nome/i)).toBeInTheDocument();
  });
});

// ─── sessão encerrada / falha ─────────────────────────────────────────────────

/** Copy pt esperada no botão (a paridade dos dicionários é checada no bloco i18n). */
const NEW_CONVERSATION_LABEL = "Iniciar nova conversa";

/** Restaura sessão persistida com `status` (via GET do boot) e abre o painel. */
async function openRestoredSession(status: ChatSessionStatus): Promise<FakeRealtime> {
  const rt = createFakeRealtime();
  window.localStorage.setItem("ecw:session", JSON.stringify({ token: "t-restore", code: "A3F2" }));
  fetchMock.setResponder(sessionResponder(status));
  renderWidget(rt);
  await waitFor(() => expect(rt.subscribed).toContain("t-restore"));
  fireEvent.click(screen.getByRole("button", { name: /abrir chat/i }));
  return rt;
}

describe("sessão encerrada ou falha", () => {
  it("sessão 'closed' → composer desabilitado, aviso e botão de nova conversa", async () => {
    await openRestoredSession("closed");

    expect(screen.getByText(pt.sessionClosed)).toBeInTheDocument();
    expect(screen.getByLabelText(/mensagem/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: NEW_CONVERSATION_LABEL })).toBeInTheDocument();
  });

  it("botão de nova conversa limpa ecw:session e volta ao pré-chat form", async () => {
    const rt = await openRestoredSession("closed");

    fireEvent.click(screen.getByRole("button", { name: NEW_CONVERSATION_LABEL }));

    await waitFor(() => expect(window.localStorage.getItem("ecw:session")).toBeNull());
    // canal realtime da sessão morta desassinado
    await waitFor(() => expect(rt.unsubscribed).toContain("t-restore"));

    // pré-chat form de novo, com campos vazios e sem o aviso
    const name = screen.getByLabelText(/nome/i) as HTMLInputElement;
    const phone = screen.getByLabelText(/whatsapp/i) as HTMLInputElement;
    const message = screen.getByLabelText(/mensagem/i) as HTMLTextAreaElement;
    expect(name.value).toBe("");
    expect(phone.value).toBe("");
    expect(message.tagName).toBe("TEXTAREA");
    expect(message.value).toBe("");
    expect(screen.queryByText(pt.sessionClosed)).toBeNull();
  });

  it("sessão 'failed' → composer desabilitado + botão de nova conversa", async () => {
    await openRestoredSession("failed");

    expect(screen.getByLabelText(/mensagem/i)).toBeDisabled();
    expect(screen.getByRole("button", { name: NEW_CONVERSATION_LABEL })).toBeInTheDocument();
  });

  it("sessão 'active' → composer habilitado e nenhum botão de nova conversa", async () => {
    await openRestoredSession("active");

    expect(screen.getByLabelText(/mensagem/i)).toBeEnabled();
    expect(screen.queryByRole("button", { name: NEW_CONVERSATION_LABEL })).toBeNull();
    expect(screen.queryByText(pt.sessionClosed)).toBeNull();
  });
});

// ─── (d) honeypot ─────────────────────────────────────────────────────────────

describe("anti-spam", () => {
  it("(d) honeypot preenchido → nenhum POST /api/chat", async () => {
    const rt = createFakeRealtime();
    renderWidget(rt);

    await submitForm("http://spam.example");

    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock.calls.some((c) => c.method === "POST")).toBe(false);
    expect(rt.subscribed).toHaveLength(0);
  });
});

// ─── (e) ESC + foco ───────────────────────────────────────────────────────────

describe("acessibilidade", () => {
  it("(e) ESC fecha o painel e devolve o foco ao balão", () => {
    const rt = createFakeRealtime();
    renderWidget(rt);

    const bubble = screen.getByRole("button", { name: /abrir chat/i });
    fireEvent.click(bubble);
    expect(screen.getByRole("dialog", { name: /chat/i })).toBeInTheDocument();
    expect(bubble).toHaveAttribute("aria-expanded", "true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(bubble).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(bubble);
  });

  it("painel aberto foca o campo de texto; balão tem aria-label e aria-expanded", () => {
    const rt = createFakeRealtime();
    renderWidget(rt);
    const bubble = screen.getByRole("button", { name: /abrir chat/i });
    expect(bubble).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(bubble);
    expect(document.activeElement).toBe(screen.getByLabelText(/nome/i));
  });

  it("todos os campos do form têm label associado", () => {
    const rt = createFakeRealtime();
    renderWidget(rt);
    fireEvent.click(screen.getByRole("button", { name: /abrir chat/i }));
    for (const label of [/nome/i, /whatsapp/i, /mensagem/i]) {
      const el = screen.getByLabelText(label);
      expect(el.id).toBeTruthy();
      expect(document.querySelector(`label[for="${el.id}"]`)).not.toBeNull();
    }
  });
});
