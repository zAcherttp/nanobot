import type { SkillsLoader } from "@/agent/skills";

/**
 * List all available skills with descriptions
 */
export async function listSkills(skillsLoader: SkillsLoader): Promise<string> {
  const skills = await skillsLoader.listSkills();

  if (skills.length === 0) {
    return "No skills available.";
  }

  return skills
    .map(
      (skill) =>
        `- **${skill.name}**: ${skill.description}${
          skill.triggers ? ` (triggers: ${skill.triggers.join(", ")})` : ""
        }`,
    )
    .join("\n");
}

/**
 * Load a specific skill's content
 */
export async function loadSkill(
  skillsLoader: SkillsLoader,
  skillName: string,
): Promise<string> {
  const content = await skillsLoader.loadSkill(skillName);

  if (!content) {
    return `Skill "${skillName}" not found or failed to load.`;
  }

  return content;
}

/**
 * Get detailed info about a specific skill
 */
export async function getSkillInfo(
  skillsLoader: SkillsLoader,
  skillName: string,
): Promise<string> {
  const info = await skillsLoader.getSkillInfo(skillName);

  if (!info) {
    return `Skill "${skillName}" not found.`;
  }

  return `**${info.name}**

${info.description}

${info.triggers ? `Triggers: ${info.triggers.join(", ")}` : ""}

Path: ${info.path}`;
}
