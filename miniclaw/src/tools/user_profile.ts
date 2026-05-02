import type { AgentTool } from "@mariozechner/pi-agent-core";
import { Type } from "typebox";
import {
  REQUIRED_PROFILE_FIELDS,
  type UserProfileService,
} from "@/services/user_profile";

export function createUserProfileTools(
  profileService: UserProfileService,
): AgentTool<any, any>[] {
  return [
    {
      name: "get_user_profile",
      label: "Get User Profile",
      description: "Read the managed user profile and report missing fields.",
      parameters: Type.Object({}),
      execute: async () => {
        const document = await profileService.getDocument();
        const profile = document.profile;
        const missingFields = profileService.getMissingFields(profile);
        const text = [
          `Setup complete: ${profile.setupComplete ? "yes" : "no"}`,
          ...REQUIRED_PROFILE_FIELDS.map(
            (field) => `${field}: ${profile[field] || "(missing)"}`,
          ),
          document.stableFacts.length > 0
            ? `Stable facts: ${document.stableFacts.join(" | ")}`
            : "Stable facts: none",
          document.preferences.length > 0
            ? `Preferences: ${document.preferences.join(" | ")}`
            : "Preferences: none",
          missingFields.length > 0
            ? `Missing: ${missingFields.join(", ")}`
            : "Missing: none",
        ].join("\n");

        return {
          content: [{ type: "text", text }],
          details: { document, profile, missingFields },
        };
      },
    },
    {
      name: "update_user_profile",
      label: "Update User Profile",
      description: "Update one or more managed profile fields in USER.md.",
      parameters: Type.Object({
        name: Type.Optional(Type.String()),
        timezone: Type.Optional(Type.String()),
        language: Type.Optional(Type.String()),
        communicationStyle: Type.Optional(Type.String()),
        responseLength: Type.Optional(Type.String()),
        technicalLevel: Type.Optional(Type.String()),
        calendarProvider: Type.Optional(Type.String()),
        defaultCalendar: Type.Optional(Type.String()),
      }),
      execute: async (_toolCallId, params) => {
        const profile = await profileService.updateProfile(params);
        const missingFields = profileService.getMissingFields(profile);

        return {
          content: [
            {
              type: "text",
              text:
                missingFields.length === 0
                  ? "Updated user profile. Setup is complete."
                  : `Updated user profile. Remaining fields: ${missingFields.join(", ")}`,
            },
          ],
          details: { profile, missingFields },
        };
      },
    },
    {
      name: "record_user_fact",
      label: "Record User Fact",
      description:
        "Store an explicit confirmed user fact in USER.md. Do not use for goals or workspace decisions.",
      parameters: Type.Object({
        fact: Type.String({ minLength: 1 }),
      }),
      execute: async (_toolCallId, params) => {
        const document = await profileService.addStableFact(params.fact);
        return {
          content: [{ type: "text", text: "Recorded user fact in USER.md." }],
          details: { stableFacts: document.stableFacts },
        };
      },
    },
    {
      name: "record_user_preference",
      label: "Record User Preference",
      description:
        "Store an explicit confirmed user preference in USER.md. Use this after clarifying stable preferences.",
      parameters: Type.Object({
        preference: Type.String({ minLength: 1 }),
      }),
      execute: async (_toolCallId, params) => {
        const document = await profileService.addPreference(params.preference);
        return {
          content: [
            { type: "text", text: "Recorded user preference in USER.md." },
          ],
          details: { preferences: document.preferences },
        };
      },
    },
  ];
}
