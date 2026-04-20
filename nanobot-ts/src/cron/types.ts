export type CronSchedule =
	| {
			kind: "at";
			atMs: number;
	  }
	| {
			kind: "every";
			everyMs: number;
	  }
	| {
			kind: "cron";
			expr: string;
			tz?: string;
	  };

export interface CronAgentTurnPayload {
	kind: "agent_turn";
	message: string;
	deliver: boolean;
	channel?: string;
	to?: string;
}

export interface CronSystemEventPayload {
	kind: "system_event";
	event: string;
	message?: string;
	deliver?: false;
}

export type CronPayload = CronAgentTurnPayload | CronSystemEventPayload;

export type CronRunStatus = "ok" | "error";

export interface CronRunRecord {
	runAtMs: number;
	status: CronRunStatus;
	durationMs: number;
	error?: string;
}

export interface CronJobState {
	nextRunAtMs: number | null;
	lastRunAtMs: number | null;
	lastStatus: CronRunStatus | null;
	lastError: string | null;
	runHistory: CronRunRecord[];
}

export interface CronJob {
	id: string;
	name: string;
	enabled: boolean;
	schedule: CronSchedule;
	payload: CronPayload;
	state: CronJobState;
	createdAtMs: number;
	updatedAtMs: number;
	deleteAfterRun: boolean;
}

export interface CronStoreData {
	version: number;
	jobs: CronJob[];
}

export interface CronServiceStatus {
	enabled: boolean;
	jobs: number;
	nextWakeAtMs: number | null;
}
