export interface CalendarSafeWindow {
  start: string;
  end: string;
}

export interface CalendarSafetyPolicy {
  enabled: boolean;
  safeWindow: CalendarSafeWindow;
  eventPrefix: string;
  requireTaggedEventForMutations: boolean;
}

export interface CalendarOperationRecord<TEvent = unknown> {
  operation: "create" | "update" | "delete" | "list" | "get";
  timestamp: string;
  eventId?: string;
  event?: TEvent;
  range?: {
    start: string;
    end: string;
  };
  simulated: boolean;
  blocked?: boolean;
  reason?: string;
}

export interface CalendarExecutionAdapter<TEvent> {
  readonly simulated: boolean;
  createEvent(event: TEvent): Promise<string>;
  updateEvent(eventId: string, event: TEvent): Promise<void>;
  deleteEvent(eventId: string): Promise<void>;
  listEvents(start: Date, end: Date): Promise<TEvent[]>;
  getEvent(eventId: string): Promise<TEvent | null>;
}

export interface ProviderThrottle {
  run<T>(provider: "llm" | "gws", task: () => Promise<T>): Promise<T>;
}

export class CalendarSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarSafetyError";
  }
}
