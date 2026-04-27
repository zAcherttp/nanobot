import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "@/utils/logger";

export interface SkillMetadata {
  name: string;
  description: string;
  triggers?: string[];
  always?: boolean;
  path: string;
}

export class SkillsLoader {
  private readonly skillsPath: string;
  private skillsCache: Map<string, SkillMetadata> | null = null;

  constructor(skillsPath: string) {
    this.skillsPath = skillsPath;
  }

  /**
   * Get list of all available skills with metadata
   */
  async listSkills(): Promise<SkillMetadata[]> {
    if (this.skillsCache) {
      return Array.from(this.skillsCache.values());
    }

    const skills: SkillMetadata[] = [];

    try {
      const entries = await fs.readdir(this.skillsPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;

        const skillPath = path.join(this.skillsPath, entry.name);
        const skillFile = path.join(skillPath, "SKILL.md");

        try {
          const content = await fs.readFile(skillFile, "utf8");
          const metadata = this.parseSkillMetadata(
            content,
            entry.name,
            skillPath,
          );
          skills.push(metadata);
        } catch (err) {
          logger.debug(`Failed to load skill ${entry.name}: ${err}`);
        }
      }

      this.skillsCache = new Map(skills.map((s) => [s.name, s]));
    } catch (err) {
      logger.warn(`Failed to list skills from ${this.skillsPath}: ${err}`);
    }

    return skills;
  }

  /**
   * Load a specific skill's content
   */
  async loadSkill(skillName: string): Promise<string | null> {
    const skillPath = path.join(this.skillsPath, skillName, "SKILL.md");

    try {
      const content = await fs.readFile(skillPath, "utf8");
      // Remove frontmatter if present
      return this.stripFrontmatter(content);
    } catch (err) {
      logger.warn(`Failed to load skill ${skillName}: ${err}`);
      return null;
    }
  }

  /**
   * Get skill summary (names + descriptions)
   * Excludes always skills from the summary
   */
  async getSkillSummary(): Promise<string> {
    const skills = await this.listSkills();
    const onDemandSkills = skills.filter((s) => !s.always);

    if (onDemandSkills.length === 0) {
      return "No on-demand skills available.";
    }

    return onDemandSkills
      .map(
        (skill) =>
          `- **${skill.name}**: ${skill.description}${
            skill.triggers ? ` (triggers: ${skill.triggers.join(", ")})` : ""
          }`,
      )
      .join("\n");
  }

  /**
   * Get always skills (skills marked with always: true)
   */
  async getAlwaysSkills(): Promise<SkillMetadata[]> {
    const skills = await this.listSkills();
    return skills.filter((s) => s.always);
  }

  /**
   * Load multiple skills for context
   */
  async loadSkillsForContext(skillNames: string[]): Promise<string> {
    const parts: string[] = [];

    for (const skillName of skillNames) {
      const content = await this.loadSkill(skillName);
      if (content) {
        parts.push(`### Skill: ${skillName}\n\n${content}`);
      }
    }

    return parts.join("\n\n");
  }

  /**
   * Get detailed info about a specific skill
   */
  async getSkillInfo(skillName: string): Promise<SkillMetadata | null> {
    const skills = await this.listSkills();
    return skills.find((s) => s.name === skillName) || null;
  }

  /**
   * Parse skill metadata from SKILL.md frontmatter
   */
  private parseSkillMetadata(
    content: string,
    skillName: string,
    skillPath: string,
  ): SkillMetadata {
    const lines = content.split("\n");
    let name = skillName;
    let description = "";
    const triggers: string[] = [];
    let always = false;

    // Parse YAML frontmatter
    if (lines[0] === "---") {
      let i = 1;
      while (i < lines.length && lines[i] !== "---") {
        const line = lines[i].trim();
        if (line.startsWith("name:")) {
          name = line
            .substring(5)
            .trim()
            .replace(/^["']|["']$/g, "");
        } else if (line.startsWith("description:")) {
          description = line
            .substring(12)
            .trim()
            .replace(/^["']|["']$/g, "");
        } else if (line.startsWith("triggers:")) {
          const triggersStr = line.substring(9).trim();
          if (triggersStr.startsWith("[") && triggersStr.endsWith("]")) {
            const parsed = JSON.parse(triggersStr.replace(/'/g, '"'));
            triggers.push(...parsed);
          }
        } else if (line.startsWith("always:")) {
          const alwaysStr = line.substring(7).trim();
          always = alwaysStr === "true" || alwaysStr === "1";
        }
        i++;
      }
    }

    // If no description in frontmatter, try to extract from first paragraph
    if (!description) {
      const contentWithoutFrontmatter = this.stripFrontmatter(content);
      const firstParagraph = contentWithoutFrontmatter.split("\n\n")[0];
      description = firstParagraph.replace(/^#\s+/, "").trim();
    }

    return {
      name,
      description: description || "No description available",
      triggers: triggers.length > 0 ? triggers : undefined,
      always,
      path: skillPath,
    };
  }

  /**
   * Remove YAML frontmatter from content
   */
  private stripFrontmatter(content: string): string {
    const lines = content.split("\n");
    if (lines[0] === "---") {
      const endIdx = lines.indexOf("---", 1);
      if (endIdx !== -1) {
        return lines
          .slice(endIdx + 1)
          .join("\n")
          .trim();
      }
    }
    return content.trim();
  }

  /**
   * Clear the skills cache
   */
  clearCache(): void {
    this.skillsCache = null;
  }
}
