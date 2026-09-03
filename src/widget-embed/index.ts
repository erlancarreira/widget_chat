// src/widget-embed/index.ts — web component standalone (`<evolution-chat>`).
//
// Empacotado como IIFE (dist/widget-embed/evolution-chat.iife.js) com React, react-dom e
// @supabase/supabase-js embutidos (`noExternal`): serve para quem NÃO usa bundler — um
// <script> no HTML e a tag <evolution-chat> no body. Quem usa React importa o subpath
// "@erlancarreira/evolution-chat/widget" e renderiza <ChatWidget> diretamente.
//
//   <script src="https://cdn…/evolution-chat.iife.js"></script>
//   <evolution-chat endpoint="/api/chat" locale="pt" welcome="Precisa de ajuda?"
//                   project="Aulivra" accent="#25D366"
//                   data-supabase-url="https://xyz.supabase.co"
//                   data-supabase-key="anon…"></evolution-chat>
//
// Contrato de atributos (→ props de ChatWidgetProps):
//   endpoint → endpoint (default "/api/chat")   locale → locale (default "pt"; pt|en|es)
//   welcome  → welcome                          project  → projectName
//   accent   → accentColor                      data-supabase-url/key → createSupabaseRealtimeHandle
//
// Por que shadow DOM: o CSS do widget usa classes `.ecw-*` globais; dentro de uma página
// de terceiro isso colide com resets/estilos do hospedeiro. A shadow tree isola os dois
// lados. Consequência que o embed precisa conhecer: `injectWidgetStyles()` escreve em
// `document.head`, e folha nenhuma de `document.head` alcança o interior de uma shadow
// tree — logo o que veste o widget é o `<style>` com `WIDGET_CSS` que criamos DENTRO do
// shadow root. `injectWidgetStyles()` continua sendo chamado (é o contrato da task e é
// idempotente): só não é ele que estiliza o embed.

import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ChatWidget, injectWidgetStyles, WIDGET_CSS, type ChatWidgetProps, type WidgetLocale } from "../widget";
import { createSupabaseRealtimeHandle } from "../transports/supabase";
import type { RealtimeHandle } from "../bridge/types";

/** Atributos observados (mudou → re-render). `data-*` carregam a config de realtime. */
const OBSERVED = ["endpoint", "locale", "welcome", "project", "accent", "data-supabase-url", "data-supabase-key"];

const KNOWN_LOCALES: readonly string[] = ["pt", "en", "es"];

/**
 * Fallback quando o hospedeiro não informou Supabase (ou informou só um dos atributos):
 * assina e declara o canal imediatamente "closed", o que liga o polling de 5s do
 * `useChat` (src/widget/use-chat.ts). Sem isso o widget existiria mas nunca receberia a
 * resposta do atendente — e `createSupabaseRealtimeHandle("", "")` lançaria no mount
 * (`createClient` exige URL/key não vazias), derrubando o custom element inteiro.
 */
const pollingOnlyHandle: RealtimeHandle = {
  subscribe(_token, _onEvent, onStatus) {
    onStatus?.("closed");
    return () => {};
  },
};

class EvolutionChatElement extends HTMLElement {
  static get observedAttributes(): string[] {
    return [...OBSERVED];
  }

  // `| undefined` explícito: com exactOptionalPropertyTypes, `this.root = undefined`
  // só é atribuível se o tipo do campo incluir undefined.
  private root?: Root | undefined;

  // O handle realtime é CRIADO UMA VEZ por (url, key): `createSupabaseRealtimeHandle`
  // constrói um Supabase client (GoTrue + socket de realtime), e render() roda a cada
  // atributo alterado — sem cache, cada tecla digitada pelo hospedeiro no DOM abriria um
  // client novo ("Multiple GoTrueClient instances detected…").
  private realtime?: RealtimeHandle | undefined;
  private realtimeSource = "";

  private realtimeHandle(url: string, key: string): RealtimeHandle {
    const source = `${url}\n${key}`;
    if (this.realtime === undefined || this.realtimeSource !== source) {
      this.realtime = url !== "" && key !== "" ? createSupabaseRealtimeHandle(url, key) : pollingOnlyHandle;
      this.realtimeSource = source;
    }
    return this.realtime;
  }

  connectedCallback(): void {
    injectWidgetStyles();

    // Reconexão (o elemento é removido e reinserido no DOM): o shadow root já existe e
    // `attachShadow` lançaria — reaproveita; `disconnectedCallback` zerou `this.root`.
    const shadow = this.shadowRoot ?? this.attachShadow({ mode: "open" });

    if (this.root === undefined) {
      const style = document.createElement("style");
      style.textContent = WIDGET_CSS;
      const mount = document.createElement("div");
      shadow.appendChild(style);
      shadow.appendChild(mount);
      this.root = createRoot(mount);
    }

    this.render();
  }

  attributeChangedCallback(): void {
    // Só re-renderiza depois do primeiro mount (atributos podem vir antes do connect).
    if (this.root !== undefined) this.render();
  }

  disconnectedCallback(): void {
    this.root?.unmount();
    this.root = undefined;
  }

  private render(): void {
    const rawLocale = this.getAttribute("locale") || "pt";
    const url = this.getAttribute("data-supabase-url") || "";
    const key = this.getAttribute("data-supabase-key") || "";

    const props: ChatWidgetProps = {
      endpoint: this.getAttribute("endpoint") || "/api/chat",
      // Locale desconhecido cai em "pt": `t()` indexaria `dictionaries["fr"]` → undefined.
      locale: (KNOWN_LOCALES.includes(rawLocale) ? rawLocale : "pt") as WidgetLocale,
      welcome: this.getAttribute("welcome") || "",
      projectName: this.getAttribute("project") || "",
      realtime: this.realtimeHandle(url, key),
    };

    // accent ausente = não passar a prop (default "#25D366" é do próprio widget);
    // `accentColor: undefined` violaria exactOptionalPropertyTypes.
    const accent = this.getAttribute("accent");
    if (accent !== null && accent !== "") props.accentColor = accent;

    this.root?.render(createElement(ChatWidget, props));
  }
}

// Guarda de dupla inclusão: dois <script> do mesmo bundle (ou o bundle + uma cópia do
// widget React) não podem colidir no registro — customElements.define lança se repetido.
if (typeof customElements !== "undefined" && !customElements.get("evolution-chat")) {
  customElements.define("evolution-chat", EvolutionChatElement);
}

export { EvolutionChatElement };
