// test/embed/embed.test.tsx — <evolution-chat> (src/widget-embed) sob jsdom.
//
// O que este teste PROTEGE (contrato do bundle standalone):
//  (a) importar o módulo registra o custom element uma única vez (guarda de dupla inclusão);
//  (b) no mount ele cria shadow root, injeta a folha `.ecw-*` DENTRO da shadow tree e
//      monta o ChatWidget (balão com aria-label em pt) — sem o <style> na shadow o widget
//      renderizaria sem aparência nenhuma (document.head não alcança a shadow tree);
//  (c) atributos viram props (endpoint/project/locale/accent) e a ausência de
//      data-supabase-* NÃO derruba o mount (fallback polling → onStatus("closed"));
//  (d) attributeChangedCallback re-renderiza com as novas props;
//  (e) disconnectedCallback desmonta o root React (nada fica vivo fora do DOM) e o
//      reconectar remontou sem brigar com o shadow root já existente;
//  (f) o handle realtime é criado UMA vez por par (url, key) — re-render não multiplica
//      clientes Supabase;
//  (g) reimportar o módulo não relança `customElements.define` (dois <script>).
//
// Rede: nenhum fetch é disparado (o widget só busca histórico no boot se houver sessão no
// localStorage, e só assina realtime com token). Supabase: os testes usam URL/key falsas —
// createClient não abre conexão até subscribe(), que nunca acontece aqui.

import { act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as supabaseTransport from "../../src/transports/supabase";
import { EvolutionChatElement } from "../../src/widget-embed";

// Espia a fábrica do handle: cada chamada constrói um Supabase client (GoTrue + socket),
// então o embed precisa criar UM por par (url, key) — não um por render.
vi.mock("../../src/transports/supabase", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/transports/supabase")>();
  return { ...actual, createSupabaseRealtimeHandle: vi.fn(actual.createSupabaseRealtimeHandle) };
});

async function mount(attributes: Record<string, string> = {}): Promise<EvolutionChatElement> {
  const element = document.createElement("evolution-chat") as EvolutionChatElement;
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  await act(async () => {
    document.body.appendChild(element);
    await Promise.resolve();
  });
  return element;
}

afterEach(async () => {
  // remove() dispara disconnectedCallback → root.unmount(), que é um update React: precisa
  // de act() para não vazar "An update to Root was not wrapped in act(...)" no teste seguinte.
  await act(async () => {
    for (const node of document.querySelectorAll("evolution-chat")) node.remove();
    document.getElementById("ecw-styles")?.remove();
    await Promise.resolve();
  });
  // Sem limpeza de localStorage: nenhum teste abre sessão (e o `localStorage` do Node ≥22
  // sombreia o Storage do jsdom — ver createStorageFake em test/widget/widget.test.tsx).
  vi.restoreAllMocks();
});

describe("<evolution-chat>", () => {
  it("registra o custom element na importação do módulo", () => {
    expect(customElements.get("evolution-chat")).toBe(EvolutionChatElement);
  });

  it("reimportar o módulo não relança o registro (guarda de dupla inclusão)", async () => {
    // Dois <script> do mesmo bundle = o módulo executando de novo com o nome já tomado:
    // `customElements.define` lançaria DOMException se não houvesse o `!get(...)` no embed.
    vi.resetModules();
    await expect(import("../../src/widget-embed")).resolves.toBeDefined();
    expect(customElements.get("evolution-chat")).toBe(EvolutionChatElement); // classe antiga, intacta
  });

  it("monta o widget dentro de um shadow root com o CSS injetado na própria shadow tree", async () => {
    const element = await mount({ project: "Aulivra", welcome: "Precisa de ajuda?" });

    const shadow = element.shadowRoot;
    expect(shadow).not.toBeNull();

    const style = shadow?.querySelector("style");
    expect(style?.textContent).toContain(".ecw-root");

    const bubble = shadow?.querySelector(".ecw-button");
    expect(bubble).not.toBeNull();
    expect(bubble).toHaveAttribute("aria-label", "Abrir chat");
    expect(bubble).toHaveAttribute("aria-expanded", "false");

    // O painel abre ao clicar no balão (o pré-chat form mostra welcome/project).
    await act(async () => {
      (bubble as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(shadow?.querySelector(".ecw-panel")).not.toBeNull();
    expect(shadow?.querySelector(".ecw-welcome")?.textContent).toBe("Precisa de ajuda?");
    expect(shadow?.querySelector(".ecw-title")?.textContent).toBe("Aulivra");
  });

  it("traduz os atributos em props e aceita locale/accent", async () => {
    const element = await mount({ locale: "en", accent: "#ff0000", endpoint: "/chat/api" });
    const shadow = element.shadowRoot;

    expect(shadow?.querySelector(".ecw-button")).toHaveAttribute("aria-label", "Open chat");
    // Var CSS inline: lida por getPropertyValue (toHaveStyle não resolve custom props no jsdom).
    const root = shadow?.querySelector(".ecw-root") as HTMLElement | null;
    expect(root?.style.getPropertyValue("--ecw-accent")).toBe("#ff0000");
  });

  it("não quebra sem data-supabase-* (fallback polling) e nem com valores vazios", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const element = await mount();
    expect(element.shadowRoot?.querySelector(".ecw-button")).not.toBeNull();

    // Só um dos dois atributos também cai no fallback (createClient exigiria ambos).
    const partial = await mount({ "data-supabase-url": "https://fake.supabase.co" });
    expect(partial.shadowRoot?.querySelector(".ecw-button")).not.toBeNull();

    // Com os dois, o handle Supabase é criado sem tocar na rede.
    const full = await mount({
      "data-supabase-url": "https://fake.supabase.co",
      "data-supabase-key": "fake-anon-key",
    });
    expect(full.shadowRoot?.querySelector(".ecw-button")).not.toBeNull();

    expect(error).not.toHaveBeenCalled();
  });

  it("re-renderiza quando um atributo observado muda", async () => {
    const element = await mount({ project: "Aulivra" });
    // O título vive no painel: é preciso abrir antes de verificar (antes e depois do change).
    await act(async () => {
      (element.shadowRoot?.querySelector(".ecw-button") as HTMLButtonElement).click();
      await Promise.resolve();
    });
    expect(element.shadowRoot?.querySelector(".ecw-title")?.textContent).toBe("Aulivra");

    await act(async () => {
      element.setAttribute("project", "Outro Projeto");
      await Promise.resolve();
    });
    expect(element.shadowRoot?.querySelector(".ecw-title")?.textContent).toBe("Outro Projeto");
  });

  it("cria um único handle realtime por credencial (não um por render)", async () => {
    const factory = vi.mocked(supabaseTransport.createSupabaseRealtimeHandle);
    factory.mockClear();
    // O segundo client (credencial trocada de propósito) faz o GoTrue avisar no console.
    // restoreAllMocks no afterEach devolve os três.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    const element = await mount({
      locale: "pt",
      "data-supabase-url": "https://fake.supabase.co",
      "data-supabase-key": "chave-1",
    });
    expect(factory).toHaveBeenCalledTimes(1);

    // Re-render por atributo que NÃO é credencial: reaproveita o handle (senão cada tecla
    // digitada no DOM abriria um Supabase client novo — "Multiple GoTrueClient instances").
    await act(async () => {
      element.setAttribute("locale", "en");
      await Promise.resolve();
    });
    expect(element.shadowRoot?.querySelector(".ecw-button")).toHaveAttribute("aria-label", "Open chat");
    expect(factory).toHaveBeenCalledTimes(1);

    // Credencial mudou → handle novo (e só um).
    await act(async () => {
      element.setAttribute("data-supabase-key", "chave-2");
      await Promise.resolve();
    });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(factory).toHaveBeenLastCalledWith("https://fake.supabase.co", "chave-2");
  });

  it("desmonta o React ao sair do DOM e remonta ao voltar", async () => {
    const element = await mount({ project: "Aulivra" });
    const shadow = element.shadowRoot;
    expect(shadow?.querySelector(".ecw-button")).not.toBeNull();

    await act(async () => {
      element.remove();
      await Promise.resolve();
    });
    // Shadow tree preservada pelo browser, conteúdo React limpo pelo unmount.
    expect(shadow?.querySelector(".ecw-button")).toBeNull();

    await act(async () => {
      document.body.appendChild(element);
      await Promise.resolve();
    });
    expect(element.shadowRoot?.querySelector(".ecw-button")).not.toBeNull();
  });
});
