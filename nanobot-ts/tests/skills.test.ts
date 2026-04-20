import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import {
	parseSkillMetadata,
	SkillsLoader,
	stripFrontmatter,
} from "../src/skills/index.js";

describe("skills", () => {
	beforeEach(() => {
		delete process.env.NANOBOT_TEST_SKILL_TOKEN;
	});

	it("parses nanobot-only metadata and strips frontmatter", () => {
		const content = [
			"---",
			"description: Demo skill",
			"requires:",
			"  bins:",
			"    - rg",
			"  env:",
			"    - NANOBOT_TEST_SKILL_TOKEN",
			"---",
			"",
			"# Demo",
			"Body",
		].join("\n");

		expect(parseSkillMetadata(content)).toEqual({
			description: "Demo skill",
			requires: {
				bins: ["rg"],
				env: ["NANOBOT_TEST_SKILL_TOKEN"],
			},
		});
		expect(stripFrontmatter(content)).toBe("# Demo\nBody");
	});

	it("lists builtin and workspace skills with workspace override precedence", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-skills-"),
		);
		const builtin = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-builtin-"),
		);
		await writeSkill(builtin, "shared", "Builtin shared");
		await writeSkill(builtin, "builtin-only", "Builtin only");
		await writeSkill(
			path.join(workspace, "skills"),
			"shared",
			"Workspace shared",
		);
		await writeSkill(
			path.join(workspace, "skills"),
			"workspace-only",
			"Workspace only",
		);

		const loader = new SkillsLoader(workspace, { builtinSkillsDir: builtin });
		const skills = await loader.listSkills(false);

		expect(skills.map((skill) => [skill.name, skill.source])).toEqual([
			["shared", "workspace"],
			["workspace-only", "workspace"],
			["builtin-only", "builtin"],
		]);
	});

	it("filters unavailable skills and reports missing requirements in the summary", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-skills-"),
		);
		const skillsRoot = path.join(workspace, "skills");
		await writeSkill(skillsRoot, "available", "Available", {
			requires: "requires:\n  bins:\n    - rg",
		});
		await writeSkill(skillsRoot, "blocked", "Blocked", {
			requires: "requires:\n  env:\n    - NANOBOT_TEST_SKILL_TOKEN",
		});

		const loader = new SkillsLoader(workspace);
		const visible = await loader.listSkills(true);
		const summary = await loader.buildSkillsSummary();

		expect(visible.map((skill) => skill.name)).toContain("available");
		expect(visible.map((skill) => skill.name)).not.toContain("blocked");
		expect(summary).toContain('<skill available="false">');
		expect(summary).toContain("ENV: NANOBOT_TEST_SKILL_TOKEN");
	});

	it("loads only selected available skill bodies for context", async () => {
		const workspace = await mkdtemp(
			path.join(os.tmpdir(), "nanobot-ts-skills-"),
		);
		const skillsRoot = path.join(workspace, "skills");
		await writeSkill(skillsRoot, "selected", "Selected", {
			body: "# Selected\n\nUse this skill.",
		});
		await writeSkill(skillsRoot, "blocked", "Blocked", {
			requires: "requires:\n  env:\n    - NANOBOT_TEST_SKILL_TOKEN",
			body: "# Blocked\n\nShould not load.",
		});

		const loader = new SkillsLoader(workspace);
		const context = await loader.loadSkillsForContext([
			"selected",
			"blocked",
			"missing",
		]);

		expect(context).toContain("### Skill: selected");
		expect(context).toContain("Use this skill.");
		expect(context).not.toContain("### Skill: blocked");
		expect(context).not.toContain("### Skill: missing");
	});
});

async function writeSkill(
	root: string,
	name: string,
	description: string,
	options: {
		requires?: string;
		body?: string;
	} = {},
): Promise<void> {
	const skillDir = path.join(root, name);
	await mkdir(skillDir, { recursive: true });
	const lines = [
		"---",
		`description: ${description}`,
		...(options.requires ? [options.requires] : []),
		"---",
		"",
		options.body ?? `# ${name}`,
	];
	await writeFile(path.join(skillDir, "SKILL.md"), lines.join("\n"), "utf8");
}
