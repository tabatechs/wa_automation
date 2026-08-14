/**
 * Buckets de tempo no fuso de São Paulo.
 *
 * As métricas de ritmo só têm sentido no fuso de quem usa o grupo: "pico às
 * 20h" precisa ser 20h em São Paulo, não em UTC. Em UTC o pico da noite cairia
 * na madrugada do dia seguinte e ainda partiria a série diária ao meio.
 */

const TIMEZONE = 'America/Sao_Paulo';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  hour12: false,
  weekday: 'short',
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

/** `YYYY-MM-DD` de N dias atrás, no fuso de São Paulo. */
export function dateKeyDaysAgo(days: number, from: Date = new Date()): string {
  return timeParts(new Date(from.getTime() - days * 86_400_000)).date;
}

/** Diferença em dias inteiros entre duas datas. */
export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}
