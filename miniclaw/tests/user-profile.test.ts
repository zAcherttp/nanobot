import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { UserProfileService } from "../src/services/user_profile";

describe("UserProfileService", () => {
  let tempDir: string;
  let workspaceDir: string;
  let profileService: UserProfileService;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "miniclaw-profile-"));
    workspaceDir = path.join(tempDir, "workspace");
    profileService = new UserProfileService(workspaceDir);
    await profileService.ensureProfileFile();
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("stores managed profile fields, stable facts, and preferences in structured sections", async () => {
    await profileService.updateProfile({
      name: "Avery",
      timezone: "Asia/Saigon",
      language: "English",
      communicationStyle: "technical",
      responseLength: "adaptive",
      technicalLevel: "expert",
      calendarProvider: "gws",
      defaultCalendar: "primary",
    });
    await profileService.addStableFact("Works on a thesis about LLM scheduling assistants.");
    await profileService.addPreference("Prefers concise technical explanations.");

    const document = await profileService.getDocument();
    const prompt = await profileService.getPromptContext();

    expect(document.profile.setupComplete).toBe(true);
    expect(document.stableFacts).toContain(
      "Works on a thesis about LLM scheduling assistants.",
    );
    expect(document.preferences).toContain(
      "Prefers concise technical explanations.",
    );
    expect(prompt).toContain("## USER.md");
    expect(prompt).toContain("### Stable Facts");
    expect(prompt).toContain("### Preferences");
    expect(prompt).not.toContain("Behavioral Observations");
    expect(prompt).not.toContain("Heuristics");
  });

  it("deduplicates stable facts and preferences case-insensitively", async () => {
    await profileService.addStableFact("Lives in Ho Chi Minh City.");
    await profileService.addStableFact("lives in ho chi minh city.");
    await profileService.addPreference("Prefers morning meetings.");
    await profileService.addPreference("prefers morning meetings.");

    const document = await profileService.getDocument();

    expect(document.stableFacts).toEqual(["Lives in Ho Chi Minh City."]);
    expect(document.preferences).toEqual(["Prefers morning meetings."]);
  });

  it("falls back cleanly when managed sections are malformed", async () => {
    await fs.writeFile(
      path.join(workspaceDir, "USER.md"),
      `# User Profile

## Managed Profile
<!-- miniclaw:managed-profile:start -->
\`\`\`json
{broken}
\`\`\`
<!-- miniclaw:managed-profile:end -->

## Stable Facts
<!-- miniclaw:stable-facts:start -->
\`\`\`json
["still valid"]
\`\`\`
<!-- miniclaw:stable-facts:end -->
`,
      "utf8",
    );

    const document = await profileService.getDocument();

    expect(document.profile.name).toBe("");
    expect(document.profile.setupComplete).toBe(false);
    expect(document.stableFacts).toContain("still valid");
    expect(document.preferences).toEqual([]);
  });
});
