import { promises as fs } from "node:fs";
import path from "node:path";

const PROFILE_START = "<!-- miniclaw:managed-profile:start -->";
const PROFILE_END = "<!-- miniclaw:managed-profile:end -->";
const FACTS_START = "<!-- miniclaw:stable-facts:start -->";
const FACTS_END = "<!-- miniclaw:stable-facts:end -->";
const PREFERENCES_START = "<!-- miniclaw:preferences:start -->";
const PREFERENCES_END = "<!-- miniclaw:preferences:end -->";

export const REQUIRED_PROFILE_FIELDS = [
  "name",
  "timezone",
  "language",
  "communicationStyle",
  "responseLength",
  "technicalLevel",
  "calendarProvider",
  "defaultCalendar",
] as const;

export type RequiredProfileField = (typeof REQUIRED_PROFILE_FIELDS)[number];

export interface ManagedUserProfile {
  setupComplete: boolean;
  name: string;
  timezone: string;
  language: string;
  communicationStyle: string;
  responseLength: string;
  technicalLevel: string;
  calendarProvider: string;
  defaultCalendar: string;
}

export interface UserProfileDocument {
  profile: ManagedUserProfile;
  stableFacts: string[];
  preferences: string[];
}

const DEFAULT_PROFILE: ManagedUserProfile = {
  setupComplete: false,
  name: "",
  timezone: "",
  language: "",
  communicationStyle: "",
  responseLength: "",
  technicalLevel: "",
  calendarProvider: "",
  defaultCalendar: "",
};

const DEFAULT_DOCUMENT: UserProfileDocument = {
  profile: { ...DEFAULT_PROFILE },
  stableFacts: [],
  preferences: [],
};

export class UserProfileService {
  constructor(private readonly workspacePath: string) {}

  public get profilePath(): string {
    return path.join(this.workspacePath, "USER.md");
  }

  public async ensureProfileFile(): Promise<void> {
    try {
      await fs.access(this.profilePath);
    } catch {
      await fs.mkdir(this.workspacePath, { recursive: true });
      await fs.writeFile(this.profilePath, this.renderDocument(DEFAULT_DOCUMENT), "utf8");
    }
  }

  public async getDocument(): Promise<UserProfileDocument> {
    const content = await this.readProfileFile();
    return this.parseDocument(content);
  }

  public async getProfile(): Promise<ManagedUserProfile> {
    return (await this.getDocument()).profile;
  }

  public async updateProfile(
    updates: Partial<ManagedUserProfile>,
  ): Promise<ManagedUserProfile> {
    const document = await this.getDocument();
    const merged = {
      ...document.profile,
      ...normalizeProfileUpdates(updates),
    };
    merged.setupComplete = this.getMissingFields(merged).length === 0;
    document.profile = merged;
    await this.writeDocument(document);
    return merged;
  }

  public getMissingFields(
    profile: ManagedUserProfile,
  ): RequiredProfileField[] {
    return REQUIRED_PROFILE_FIELDS.filter((field) => !profile[field].trim());
  }

  public async getMissingProfileFields(): Promise<RequiredProfileField[]> {
    return this.getMissingFields(await this.getProfile());
  }

  public async isSetupComplete(): Promise<boolean> {
    return (await this.getMissingProfileFields()).length === 0;
  }

  public async addStableFact(fact: string): Promise<UserProfileDocument> {
    const document = await this.getDocument();
    if (!pushUniqueString(document.stableFacts, fact)) {
      return document;
    }
    await this.writeDocument(document);
    return document;
  }

  public async addPreference(preference: string): Promise<UserProfileDocument> {
    const document = await this.getDocument();
    if (!pushUniqueString(document.preferences, preference)) {
      return document;
    }
    await this.writeDocument(document);
    return document;
  }

  public async getPromptContext(): Promise<string | null> {
    const document = await this.getDocument();
    const lines: string[] = [];

    lines.push("## USER.md");
    lines.push("");
    lines.push("### Managed Profile");
    lines.push(
      ...REQUIRED_PROFILE_FIELDS.map(
        (field) => `- ${field}: ${document.profile[field] || "(missing)"}`,
      ),
    );

    if (document.stableFacts.length > 0) {
      lines.push("");
      lines.push("### Stable Facts");
      lines.push(...document.stableFacts.map((fact) => `- ${fact}`));
    }

    if (document.preferences.length > 0) {
      lines.push("");
      lines.push("### Preferences");
      lines.push(...document.preferences.map((preference) => `- ${preference}`));
    }

    return lines.join("\n");
  }

  private async readProfileFile(): Promise<string> {
    await this.ensureProfileFile();
    return fs.readFile(this.profilePath, "utf8");
  }

  private async writeDocument(document: UserProfileDocument): Promise<void> {
    await fs.writeFile(this.profilePath, this.renderDocument(document), "utf8");
  }

  private parseDocument(content: string): UserProfileDocument {
    const profile = this.parseJsonSection<ManagedUserProfile>(
      content,
      PROFILE_START,
      PROFILE_END,
      { ...DEFAULT_PROFILE },
    );
    profile.setupComplete = this.getMissingFields(profile).length === 0;

    return {
      profile,
      stableFacts: this.parseJsonSection<string[]>(
        content,
        FACTS_START,
        FACTS_END,
        [],
      ),
      preferences: this.parseJsonSection<string[]>(
        content,
        PREFERENCES_START,
        PREFERENCES_END,
        [],
      ),
    };
  }

  private parseJsonSection<T>(
    content: string,
    startMarker: string,
    endMarker: string,
    fallback: T,
  ): T {
    const match = new RegExp(
      `${escapeRegExp(startMarker)}\\s*\\\`\\\`\\\`json\\s*([\\s\\S]*?)\\s*\\\`\\\`\\\`\\s*${escapeRegExp(endMarker)}`,
      "m",
    ).exec(content);

    if (!match) {
      return structuredClone(fallback);
    }

    try {
      return JSON.parse(match[1]) as T;
    } catch {
      return structuredClone(fallback);
    }
  }

  private renderDocument(document: UserProfileDocument): string {
    const normalized = {
      ...document,
      profile: {
        ...document.profile,
        setupComplete: this.getMissingFields(document.profile).length === 0,
      },
      stableFacts: uniqueTrimmed(document.stableFacts),
      preferences: uniqueTrimmed(document.preferences),
    };

    return `# User Profile

Information about the user that has been explicitly stated or confirmed.

## Managed Profile
${renderJsonSection(PROFILE_START, PROFILE_END, normalized.profile)}

## Stable Facts
${renderJsonSection(FACTS_START, FACTS_END, normalized.stableFacts)}

## Preferences
${renderJsonSection(PREFERENCES_START, PREFERENCES_END, normalized.preferences)}

## Notes

- Keep only explicit confirmed user information here.
- Do not store workspace/project conventions in USER.md; use MEMORY.md instead.
- Do not store goals here; use GOALS.md instead.
`;
  }
}

function normalizeProfileUpdates(
  updates: Partial<ManagedUserProfile>,
): Partial<ManagedUserProfile> {
  const normalized: Partial<ManagedUserProfile> = {};

  for (const [key, value] of Object.entries(updates)) {
    if (key === "setupComplete") {
      normalized.setupComplete = Boolean(value);
      continue;
    }

    if (typeof value === "string") {
      normalized[key as RequiredProfileField] = value.trim();
    }
  }

  return normalized;
}

function renderJsonSection(
  startMarker: string,
  endMarker: string,
  value: unknown,
): string {
  return `${startMarker}
\`\`\`json
${JSON.stringify(value, null, 2)}
\`\`\`
${endMarker}`;
}

function pushUniqueString(values: string[], next: string): boolean {
  const normalized = next.trim();
  if (!normalized) return false;
  if (values.some((entry) => entry.toLowerCase() === normalized.toLowerCase())) {
    return false;
  }
  values.push(normalized);
  return true;
}

function uniqueTrimmed(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const value of values) {
    const normalized = value.trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
