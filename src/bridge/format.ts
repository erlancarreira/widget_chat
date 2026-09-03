// src/bridge/format.ts — Strategy de formatação do texto que entra no grupo WhatsApp.
//
// Isolado de propósito: o corpo persistido no store é SEMPRE o texto cru do visitante
// (é o que o widget mostra), e só o que viaja para a Evolution recebe o prefixo que
// identifica origem/código/nome. Trocar a identidade visual do relay = mexer aqui.

/** Primeira mensagem da conversa no grupo: destaca código, nome e quebra de linha. */
export function formatFirstMessage(code: string, name: string, text: string): string {
  return `🆕 #${code} — ${name} (site):\n${text}`;
}

/** Demais mensagens vindas do site: prefixo curto na mesma linha. */
export function formatFollowup(name: string, text: string): string {
  return `${name} (site): ${text}`;
}
