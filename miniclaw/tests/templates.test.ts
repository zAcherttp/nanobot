import { describe, it, expect, beforeEach, vi } from "vitest";
import { promises as fs } from "node:fs";
import { TemplateEngine } from "../src/utils/templates";

// Mock fs module
vi.mock("node:fs", () => ({
  promises: {
    readFile: vi.fn(),
    readdir: vi.fn(),
  },
}));

describe("TemplateEngine", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("renderString", () => {
    it("should replace simple variable", () => {
      const template = "Hello {{name}}!";
      const variables = { name: "World" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Hello World!");
    });

    it("should replace multiple variables", () => {
      const template = "Hello {{name}}, you are {{age}} years old.";
      const variables = { name: "John", age: 30 };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Hello John, you are 30 years old.");
    });

    it("should handle nested variables with dot notation", () => {
      const template = "User: {{user.name}}, Email: {{user.email}}";
      const variables = {
        user: {
          name: "Alice",
          email: "alice@example.com",
        },
      };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("User: Alice, Email: alice@example.com");
    });

    it("should handle deeply nested variables", () => {
      const template = "Value: {{config.database.host}}";
      const variables = {
        config: {
          database: {
            host: "localhost",
            port: 5432,
          },
        },
      };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Value: localhost");
    });

    it("should keep original placeholder when variable not found", () => {
      const template = "Hello {{name}}, {{missing}}!";
      const variables = { name: "World" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Hello World, {{missing}}!");
    });

    it("should handle whitespace in placeholder", () => {
      const template = "Hello {{ name }}!";
      const variables = { name: "World" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Hello World!");
    });

    it("should convert numbers to strings", () => {
      const template = "Count: {{count}}, Price: ${{price}}";
      const variables = { count: 42, price: 19.99 };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Count: 42, Price: $19.99");
    });

    it("should handle boolean values", () => {
      const template = "Enabled: {{enabled}}, Active: {{active}}";
      const variables = { enabled: true, active: false };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Enabled: true, Active: false");
    });

    it("should handle null and undefined values", () => {
      const template = "Value1: {{value1}}, Value2: {{value2}}";
      const variables = { value1: null, value2: undefined };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Value1: null, Value2: {{value2}}");
    });

    it("should handle empty string", () => {
      const template = "Hello {{name}}!";
      const variables = { name: "" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Hello !");
    });

    it("should handle array values", () => {
      const template = "Items: {{items}}";
      const variables = { items: ["apple", "banana", "cherry"] };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Items: apple,banana,cherry");
    });

    it("should handle object values", () => {
      const template = "Config: {{config}}";
      const variables = { config: { key: "value" } };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Config: [object Object]");
    });

    it("should handle multiple occurrences of same variable", () => {
      const template = "{{name}} is {{name}} and {{name}} again";
      const variables = { name: "test" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("test is test and test again");
    });

    it("should handle template with no variables", () => {
      const template = "Hello World!";
      const variables = {};

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Hello World!");
    });

    it("should handle empty template", () => {
      const template = "";
      const variables = { name: "test" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("");
    });

    it("should handle special characters in variable values", () => {
      const template = "Message: {{message}}";
      const variables = { message: "Hello\nWorld\t!" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Message: Hello\nWorld\t!");
    });

    it("should handle nested null values", () => {
      const template = "Value: {{user.profile.name}}";
      const variables = {
        user: {
          profile: null,
        },
      };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Value: {{user.profile.name}}");
    });

    it("should handle nested undefined values", () => {
      const template = "Value: {{user.profile.name}}";
      const variables = {
        user: {
          profile: undefined,
        },
      };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Value: {{user.profile.name}}");
    });

    it("should handle mixed nested and simple variables", () => {
      const template =
        "{{user.name}} is {{age}} years old from {{user.location.city}}";
      const variables = {
        user: {
          name: "Bob",
          location: {
            city: "New York",
          },
        },
        age: 25,
      };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Bob is 25 years old from New York");
    });
  });

  describe("renderTemplate", () => {
    it("should render template from file", async () => {
      const templateContent = "Hello {{name}}!";
      vi.mocked(fs.readFile).mockResolvedValue(templateContent);

      const result = await TemplateEngine.renderTemplate("/test/template.md", {
        name: "World",
      });

      expect(result).toBe("Hello World!");
      expect(fs.readFile).toHaveBeenCalledWith("/test/template.md", "utf8");
    });

    it("should throw error when file read fails", async () => {
      vi.mocked(fs.readFile).mockRejectedValue(new Error("File not found"));

      await expect(
        TemplateEngine.renderTemplate("/test/template.md", { name: "World" }),
      ).rejects.toThrow("File not found");
    });

    it("should handle complex template from file", async () => {
      const templateContent = `
# Welcome {{user.name}}

You are logged in as {{user.email}}.

Your role: {{user.role}}
`;
      vi.mocked(fs.readFile).mockResolvedValue(templateContent);

      const result = await TemplateEngine.renderTemplate("/test/template.md", {
        user: {
          name: "Alice",
          email: "alice@example.com",
          role: "admin",
        },
      });

      expect(result).toContain("Welcome Alice");
      expect(result).toContain("You are logged in as alice@example.com");
      expect(result).toContain("Your role: admin");
    });
  });

  describe("renderTemplatesFromDir", () => {
    it("should render all markdown files in directory", async () => {
      const mockEntries = [
        { name: "template1.md", isFile: () => true },
        { name: "template2.md", isFile: () => true },
        { name: "not-md.txt", isFile: () => true },
        { name: "subdir", isFile: () => false },
      ];

      const template1Content = "Hello {{name}}!";
      const template2Content = "Goodbye {{name}}!";

      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(template1Content)
        .mockResolvedValueOnce(template2Content);

      const results = await TemplateEngine.renderTemplatesFromDir(
        "/test/templates",
        {
          name: "World",
        },
      );

      expect(results.size).toBe(2);
      expect(results.get("template1.md")).toBe("Hello World!");
      expect(results.get("template2.md")).toBe("Goodbye World!");
    });

    it("should skip non-markdown files", async () => {
      const mockEntries = [
        { name: "template.md", isFile: () => true },
        { name: "config.json", isFile: () => true },
        { name: "data.txt", isFile: () => true },
      ];

      const templateContent = "Test {{value}}";
      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(templateContent);

      const results = await TemplateEngine.renderTemplatesFromDir(
        "/test/templates",
        {
          value: "123",
        },
      );

      expect(results.size).toBe(1);
      expect(results.has("template.md")).toBe(true);
      expect(results.has("config.json")).toBe(false);
      expect(results.has("data.txt")).toBe(false);
    });

    it("should skip directories", async () => {
      const mockEntries = [
        { name: "template.md", isFile: () => true },
        { name: "subdir", isFile: () => false },
      ];

      const templateContent = "Test {{value}}";
      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile).mockResolvedValue(templateContent);

      const results = await TemplateEngine.renderTemplatesFromDir(
        "/test/templates",
        {
          value: "123",
        },
      );

      expect(results.size).toBe(1);
    });

    it("should handle empty directory", async () => {
      vi.mocked(fs.readdir).mockResolvedValue([]);

      const results = await TemplateEngine.renderTemplatesFromDir(
        "/test/templates",
        {},
      );

      expect(results.size).toBe(0);
    });

    it("should handle file read errors gracefully", async () => {
      const mockEntries = [
        { name: "valid.md", isFile: () => true },
        { name: "invalid.md", isFile: () => true },
      ];

      const validContent = "Valid {{value}}";
      vi.mocked(fs.readdir).mockResolvedValue(mockEntries as any);
      vi.mocked(fs.readFile)
        .mockResolvedValueOnce(validContent)
        .mockRejectedValueOnce(new Error("Read error"));

      const results = await TemplateEngine.renderTemplatesFromDir(
        "/test/templates",
        {
          value: "test",
        },
      );

      expect(results.size).toBe(1);
      expect(results.get("valid.md")).toBe("Valid test");
    });

    it("should handle directory read errors", async () => {
      vi.mocked(fs.readdir).mockRejectedValue(new Error("Permission denied"));

      const results = await TemplateEngine.renderTemplatesFromDir(
        "/test/templates",
        {},
      );

      expect(results.size).toBe(0);
    });
  });

  describe("edge cases", () => {
    it("should handle malformed placeholders", () => {
      const template = "Hello {{name}!";
      const variables = { name: "World" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Hello {{name}!");
    });

    it("should handle nested braces", () => {
      const template = "Value: {{{nested}}}";
      const variables = { nested: "test" };

      const result = TemplateEngine.renderString(template, variables);

      // The implementation doesn't support nested braces, so it keeps the placeholder
      expect(result).toBe("Value: {{{nested}}}");
    });

    it("should handle empty variable name", () => {
      const template = "Value: {{}}";
      const variables = {};

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Value: {{}}");
    });

    it("should handle variable with spaces in name", () => {
      const template = "Value: {{user name}}";
      const variables = { "user name": "John" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Value: John");
    });

    it("should handle very long variable values", () => {
      const longValue = "a".repeat(10000);
      const template = "Value: {{value}}";
      const variables = { value: longValue };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe(`Value: ${longValue}`);
    });

    it("should handle many variables", () => {
      const variables: Record<string, string> = {};
      const templateParts: string[] = [];
      for (let i = 0; i < 100; i++) {
        variables[`var${i}`] = `value${i}`;
        templateParts.push(`{{var${i}}}`);
      }

      const template = templateParts.join(" ");
      const result = TemplateEngine.renderString(template, variables);

      expect(result).toContain("value0");
      expect(result).toContain("value99");
    });

    it("should handle unicode characters", () => {
      const template = "Hello {{name}}! 你好 {{greeting}}";
      const variables = { name: "世界", greeting: "你好" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Hello 世界! 你好 你好");
    });

    it("should handle emoji characters", () => {
      const template = "Mood: {{mood}}";
      const variables = { mood: "😀🎉" };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toBe("Mood: 😀🎉");
    });
  });

  describe("real-world scenarios", () => {
    it("should render system prompt template", () => {
      const template = `
# Agent Identity

You are {{agent.name}}, a {{agent.type}} assistant.

## Instructions

{{instructions}}

## Constraints

{{constraints}}
`;
      const variables = {
        agent: {
          name: "Claude",
          type: "AI",
        },
        instructions: "Help users with their tasks.",
        constraints: "Be concise and accurate.",
      };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toContain("You are Claude, a AI assistant.");
      expect(result).toContain("Help users with their tasks.");
      expect(result).toContain("Be concise and accurate.");
    });

    it("should render email template", () => {
      const template = `
Subject: {{subject}}

Dear {{recipient.name}},

{{body}}

Best regards,
{{sender.name}}
{{sender.title}}
`;
      const variables = {
        subject: "Meeting Reminder",
        recipient: {
          name: "John Doe",
        },
        body: "This is a reminder about our meeting tomorrow at 2 PM.",
        sender: {
          name: "Jane Smith",
          title: "Project Manager",
        },
      };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toContain("Subject: Meeting Reminder");
      expect(result).toContain("Dear John Doe,");
      expect(result).toContain("Best regards,\nJane Smith\nProject Manager");
    });

    it("should render configuration template", () => {
      const template = `
# Configuration

Database:
  Host: {{config.db.host}}
  Port: {{config.db.port}}
  Name: {{config.db.name}}

API:
  Key: {{config.api.key}}
  URL: {{config.api.url}}
`;
      const variables = {
        config: {
          db: {
            host: "localhost",
            port: 5432,
            name: "mydb",
          },
          api: {
            key: "secret123",
            url: "https://api.example.com",
          },
        },
      };

      const result = TemplateEngine.renderString(template, variables);

      expect(result).toContain("Host: localhost");
      expect(result).toContain("Port: 5432");
      expect(result).toContain("Key: secret123");
    });
  });
});
