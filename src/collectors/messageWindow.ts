/**
 * Janela deslizante das mensagens recentes por grupo.
 *
 * Alimentada pelo coletor de mensagens e lida pelo coletor de reações: só faz
 * sentido procurar reações em mensagens ainda relevantes. Limita por quantidade
 * e por idade, o que impede o crescimento sem fim da memória num grupo movimentado.
 */

export interface TrackedMessage {
  messageId: string;
  /** Momento da mensagem em epoch ms. */
  at: number;
}

export class MessageWindow {
  private readonly byGroup = new Map<string, TrackedMessage[]>();

  constructor(
    private readonly maxSize: number,
    private readonly maxAgeMs: number,
    /**
     * Chamado na primeira vez que uma mensagem entra na janela. O coletor de
     * reações usa isto para fixar a linha de base como "nenhuma reação": vimos a
     * mensagem chegar ao vivo, então qualquer reação encontrada depois é nova de
     * verdade — sem esse gancho, a primeira varredura seria silenciosa e
     * perderia as reações dos primeiros ~30 s de vida da mensagem.
     */
    private readonly onFirstSeen?: (
      groupId: string,
      messageId: string,
      at: number,
      fromMe: boolean,
    ) => void,
  ) {}

  /**
   * `fromMe` distingue as mensagens da própria conta: só elas têm confirmação
   * de leitura, e é por este gancho que o coletor de leituras fica sabendo
   * quais vigiar.
   */
  track(groupId: string, messageId: string, at: number, fromMe = false): void {
    if (!messageId) return;
    const list = this.byGroup.get(groupId) ?? [];
    if (list.some((m) => m.messageId === messageId)) return;
    const stamp = at || Date.now();
    list.push({ messageId, at: stamp });
    this.byGroup.set(groupId, this.prune(list));
    this.onFirstSeen?.(groupId, messageId, stamp, fromMe);
  }

  /** Ids atualmente na janela do grupo. */
  ids(groupId: string): Set<string> {
    const list = this.byGroup.get(groupId);
    if (!list) return new Set();
    const pruned = this.prune(list);
    this.byGroup.set(groupId, pruned);
    return new Set(pruned.map((m) => m.messageId));
  }

  size(groupId: string): number {
    return this.byGroup.get(groupId)?.length ?? 0;
  }

  private prune(list: TrackedMessage[]): TrackedMessage[] {
    const cutoff = Date.now() - this.maxAgeMs;
    const fresh = list.filter((m) => m.at >= cutoff);
    // Mantém as mais recentes quando estoura o tamanho.
    return fresh.length > this.maxSize
      ? fresh.sort((a, b) => a.at - b.at).slice(fresh.length - this.maxSize)
      : fresh;
  }
}
