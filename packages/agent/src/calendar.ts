import { houseEvents, type HouseEvent, type HouseEventType } from "./state.js";
import { log } from "./log.js";

// ── Tool handlers ─────────────────────────────────────────────────────────────

interface AddHouseEventArgs {
  title: string;
  event_date: string; // YYYY-MM-DD
  event_time?: string;
  duration_minutes?: number;
  all_day?: boolean;
  affects_members?: string[];
  event_type: HouseEventType;
  notes?: string;
  created_by: string;
}

export function addHouseEvent(args: AddHouseEventArgs): { eventId: string; message: string } {
  const id = `evt_${Date.now()}`;
  const event: HouseEvent = {
    id,
    title: args.title,
    eventDate: args.event_date,
    eventTime: args.event_time,
    durationMinutes: args.duration_minutes,
    allDay: args.all_day ?? !args.event_time,
    createdBy: args.created_by,
    affectsMembers: args.affects_members ?? [],
    eventType: args.event_type,
    notes: args.notes,
    createdAt: new Date().toISOString(),
  };

  houseEvents.set(id, event);
  log("calendar.event_added", {
    id,
    title: event.title,
    date: event.eventDate,
    type: event.eventType,
    createdBy: event.createdBy,
  });

  const who =
    event.affectsMembers.length > 0
      ? event.affectsMembers.map((m) => m.toLowerCase()).join(", ")
      : "whole house";

  const timeHint = event.eventTime ? ` at ${event.eventTime}` : "";
  const durHint =
    event.durationMinutes ? ` for ${Math.round(event.durationMinutes / 60 * 10) / 10}h` : "";

  return {
    eventId: id,
    message: `noted: ${event.title.toLowerCase()}${timeHint}${durHint} on ${event.eventDate} (${who})`,
  };
}

// ── Get calendar ──────────────────────────────────────────────────────────────

interface GetCalendarArgs {
  days?: number;
}

export function getHouseCalendar(args: GetCalendarArgs = {}): string {
  const days = args.days ?? 7;
  const now = new Date();
  const cutoff = new Date(now.getTime() + days * 86_400_000);

  const upcoming = [...houseEvents.values()]
    .filter((e) => {
      const d = new Date(e.eventDate);
      return d >= now && d <= cutoff;
    })
    .sort((a, b) => a.eventDate.localeCompare(b.eventDate));

  if (upcoming.length === 0) {
    return `nothing on the calendar for the next ${days} days 📅`;
  }

  const lines = upcoming.map((e) => {
    const dayLabel = formatDayLabel(e.eventDate, now);
    const timeHint = e.eventTime ? ` ${e.eventTime}` : "";
    const durHint =
      e.durationMinutes
        ? `-${addMinutes(e.eventTime ?? "00:00", e.durationMinutes)}`
        : "";
    const whoHint =
      e.affectsMembers.length > 0
        ? ` (${e.affectsMembers.map((m) => m.toLowerCase()).join(", ")})`
        : "";
    return `${dayLabel}  ${e.title.toLowerCase()}${timeHint}${durHint}${whoHint}`;
  });

  return `📅 next ${days} days\n${lines.join("\n")}`;
}

function formatDayLabel(dateStr: string, now: Date): string {
  const d = new Date(dateStr + "T12:00:00"); // noon to avoid UTC offset issues
  const diffDays = Math.round((d.getTime() - now.setHours(0, 0, 0, 0)) / 86_400_000);
  if (diffDays === 0) return "today    ";
  if (diffDays === 1) return "tomorrow ";
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }).toLowerCase().padEnd(9);
}

function addMinutes(time: string, mins: number): string {
  const [h, m] = time.split(":").map(Number);
  const total = (h * 60 + m + mins) % (24 * 60);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

// ── Conflict check ────────────────────────────────────────────────────────────

interface CheckConflictsArgs {
  event_date: string;
  event_time?: string;
  duration_minutes?: number;
  affects_members?: string[];
}

export interface CalendarConflict {
  eventId: string;
  title: string;
  eventDate: string;
  eventTime?: string;
  affectsMembers: string[];
}

export function checkCalendarConflicts(args: CheckConflictsArgs): CalendarConflict[] {
  const conflicts: CalendarConflict[] = [];
  const proposedStart = args.event_time
    ? toMinutes(args.event_time)
    : null;
  const proposedEnd =
    proposedStart !== null && args.duration_minutes
      ? proposedStart + args.duration_minutes
      : proposedStart;

  for (const event of houseEvents.values()) {
    if (event.eventDate !== args.event_date) continue;

    const eventStart = event.eventTime ? toMinutes(event.eventTime) : null;
    const eventEnd =
      eventStart !== null && event.durationMinutes
        ? eventStart + event.durationMinutes
        : eventStart;

    // Check member overlap
    const memberOverlap =
      args.affects_members && args.affects_members.length > 0
        ? event.affectsMembers.length === 0 || // whole-house event conflicts with anyone
          args.affects_members.some(
            (m) =>
              event.affectsMembers.length === 0 ||
              event.affectsMembers.includes(m)
          )
        : true;

    if (!memberOverlap) continue;

    // Time overlap (only when both have explicit times)
    if (
      proposedStart !== null &&
      eventStart !== null &&
      proposedEnd !== null &&
      eventEnd !== null
    ) {
      const overlaps = proposedStart < eventEnd && proposedEnd > eventStart;
      if (!overlaps) continue;
    }

    conflicts.push({
      eventId: event.id,
      title: event.title,
      eventDate: event.eventDate,
      eventTime: event.eventTime,
      affectsMembers: event.affectsMembers,
    });
  }

  return conflicts;
}

function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

// ── Nag helpers ───────────────────────────────────────────────────────────────

/** Events starting within N hours. Used by the nag engine. */
export function getEventsWithin(hours: number, now: Date = new Date()): HouseEvent[] {
  const cutoffMs = now.getTime() + hours * 3_600_000;
  return [...houseEvents.values()].filter((e) => {
    const eventMs = new Date(
      e.eventTime ? `${e.eventDate}T${e.eventTime}` : `${e.eventDate}T00:00:00`
    ).getTime();
    return eventMs > now.getTime() && eventMs <= cutoffMs;
  });
}

/** Events exactly on a given date (YYYY-MM-DD). */
export function getEventsOnDate(date: string): HouseEvent[] {
  return [...houseEvents.values()].filter((e) => e.eventDate === date);
}
