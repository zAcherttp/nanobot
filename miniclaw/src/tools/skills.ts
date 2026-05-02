import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import type { SkillsLoader } from "@/agent/skills";

export function createSkillTools(
  skillsLoader: SkillsLoader,
): AgentTool<any, any>[] {
  return [
    {
      name: "list_skills",
      label: "List Skills",
      description: "List available skills with short descriptions.",
      parameters: Type.Object({}),
      execute: async () => {
        const skills = await skillsLoader.listSkills();
        const summary =
          skills.length === 0
            ? "No skills available."
            : skills
                .map(
                  (skill) =>
                    `- ${skill.name}: ${skill.description}${
                      skill.triggers?.length
                        ? ` (triggers: ${skill.triggers.join(", ")})`
                        : ""
                    }`,
                )
                .join("\n");

        return {
          content: [{ type: "text", text: summary }],
          details: { skills },
        };
      },
    },
    {
      name: "load_skill",
      label: "Load Skill",
      description: "Load the full instructions for a specific skill.",
      parameters: Type.Object({
        skill_name: Type.String({
          description: "Skill directory name, for example gws-calendar-agenda.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const content = await skillsLoader.loadSkill(params.skill_name);
        if (!content) {
          throw new Error(`Skill not found: ${params.skill_name}`);
        }

        return {
          content: [{ type: "text", text: content }],
          details: {
            skillName: params.skill_name,
          },
        };
      },
    },
    {
      name: "get_skill_info",
      label: "Get Skill Info",
      description:
        "Get metadata for a skill without loading the full instructions.",
      parameters: Type.Object({
        skill_name: Type.String({
          description: "Skill directory name.",
        }),
      }),
      execute: async (_toolCallId, params) => {
        const info = await skillsLoader.getSkillInfo(params.skill_name);
        if (!info) {
          throw new Error(`Skill not found: ${params.skill_name}`);
        }

        const text = [
          `Name: ${info.name}`,
          `Description: ${info.description}`,
          info.triggers?.length
            ? `Triggers: ${info.triggers.join(", ")}`
            : "Triggers: none",
          `Path: ${info.path}`,
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: info,
        };
      },
    },
  ];
}
