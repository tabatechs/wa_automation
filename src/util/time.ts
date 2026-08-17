/**
 * Tempo no fuso de São Paulo — buckets e carimbos.
 *
 * As métricas de ritmo só têm sentido no fuso de quem usa o grupo: "pico às
 * 20h" precisa ser 20h em São Paulo, não em UTC. Em UTC o pico da noite cairia
 * na madrugada do dia seguinte e ainda partiria a série diária ao meio.
 *
 * O mesmo vale para os carimbos gravados nos eventos e no log. `toISOString()`
 * devolve sempre UTC (`...Z`), e ler "21:05Z" para uma mensagem das 18:05 é
 * atrito em toda conferência manual. `localIso()` grava o MESMO instante com o
 * deslocamento explícito (`...-03:00`): `new Date()`, o Mongo e qualquer parser
 * de ISO 8601 continuam entendendo, e o horário sai legível.
 *
 * Fuso único e fixo, de propósito: o projeto é de uma campanha em São Paulo, e
 * um fuso configurável só criaria a chance de dois processos gravarem a mesma
 * série em fusos diferentes. Para mudar, é esta constante.
 */

export const TIMEZONE = 'America/Sao_Paulo';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hourCycle: 'h23',
  weekday: 'short',
});

/** Mesmos campos do `localIso`, mais o deslocamento do fuso naquela data. */
const isoFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
  timeZoneName: 'longOffset',
});

const WEEKDAYS: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

export interface TimeParts {
  /** `YYYY-MM-DD` no fuso de São Paulo — a chave dos buckets diários. */
  date: string;
  /** 0–23, hora local. */
  hour: number;
  /** 0 = domingo. */
  weekday: number;
}

export function timeParts(when: Date): TimeParts {
  const parts = formatter.formatToParts(when);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  // `hour12: false` produz "24" para a meia-noite em alguns runtimes.
  const rawHour = Number(get('hour'));
  const hour = Number.isFinite(rawHour) ? rawHour % 24 : 0;

  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    hour,
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/**
 * ISO 8601 no fuso de São Paulo: `2026-08-17T18:05:16.159-03:00`.
 *
 * É o mesmo instante que `toISOString()` produziria — o deslocamento faz parte
 * do formato, então nada que consome esses campos precisa mudar. O horário de
 * verão, se voltar, entra sozinho: o deslocamento é calculado para a data.
 */
export function localIso(when: Date = new Date()): string {
  const parts = isoFormatter.formatToParts(when);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';

  const ms = String(when.getMilliseconds()).padStart(3, '0');
  // `longOffset` devolve "GMT-03:00" e, em UTC, apenas "GMT".
  const offset = get('timeZoneName').replace('GMT', '') || 'Z';

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}.${ms}${offset}`;
}

/**
 * Carimbo compacto para nome de arquivo: `2026-08-17T18-05-16`.
 * Sem os dois-pontos, que não valem em todo sistema de arquivos.
 */
export function localStamp(when: Date = new Date()): string {
  return localIso(when).slice(0, 19).replace(/:/g, '-');
}

/** `YYYY-MM-DD` no fuso de São Paulo — o dia a que um instante pertence. */
export function dateKey(when: Date = new Date()): string {
  return timeParts(when).date;
}

/** `YYYY-MM-DD` de N dias atrás, no fuso de São Paulo. */
export function dateKeyDaysAgo(days: number, from: Date = new Date()): string {
  return timeParts(new Date(from.getTime() - days * 86_400_000)).date;
}

/** Diferença em dias inteiros entre duas datas. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
