/**
 * Pesos e cortes do score de engajamento.
 *
 * Ficam isolados aqui de propósito: mexer na definição de "engajado" não pode
 * exigir tocar em pipeline de agregação. Depois de mudar qualquer coisa neste
 * arquivo, rode `npm run mongo:build` para reescrever os scores.
 *
 * O score é deliberadamente simples — quatro dimensões, sem sutileza. As
 * métricas cruas em `people` é que são a matéria-prima; o score existe só para
 * dar uma ordenação padrão.
 */

export const SCORING = {
  /** Somam 1. Cada dimensão entra como percentil (0–100) dentro da base. */
  weights: {
    /** Quanto a pessoa fala. */
    volume: 0.35,
    /** Em quantos dos últimos 30 dias ela apareceu — constância vale mais que picos. */
    consistency: 0.3,
    /** Quanto o que ela diz repercute (reações e respostas por mensagem). */
    resonance: 0.2,
    /** Há quanto tempo falou pela última vez. */
    recency: 0.15,
  },

  /** Percentil mínimo de cada faixa. */
  tiers: {
    champion: 90,
    active: 65,
    occasional: 30,
  },

  /** Sem mensagem há mais dias que isto, a pessoa é considerada adormecida. */
  dormantAfterDays: 30,

  /** Até este número de mensagens, quem reage é "observador", não inativo. */
  observerMaxMessages: 3,

  /** Variação relativa entre duas semanas a partir da qual há tendência. */
  trendThreshold: 0.2,
} as const;

export type PersonTier =
  | 'champion'
  | 'active'
  | 'occasional'
  | 'observer'
  | 'lurker'
  | 'dormant';

export interface TierInput {
  messagesSent: number;
  isLurker: boolean;
  isDormant: boolean;
  isObserver: boolean;
}

/**
 * Faixa de uma pessoa.
 *
 * A ordem das checagens importa: os estados que descrevem *como* a pessoa
 * participa — nunca falou, sumiu, só reage — vêm antes do score, porque para
 * decidir um convite eles dizem mais que a posição no ranking. Alguém que era
 * campeão e sumiu há dois meses não é um bom convite hoje; alguém que nunca
 * escreveu mas reage em tudo pode ser.
 */
export function tierOf(score: number, input: TierInput): PersonTier {
  if (input.isLurker) return 'lurker';
  if (input.isDormant) return 'dormant';
  if (input.isObserver) return 'observer';
  if (score >= SCORING.tiers.champion) return 'champion';
  if (score >= SCORING.tiers.active) return 'active';
  if (score >= SCORING.tiers.occasional) return 'occasional';
  return 'occasional';
}
