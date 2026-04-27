import { promises as fs } from "node:fs";
import path from "node:path";
import { logger } from "../utils/logger";

/**
 * Simple template rendering engine
 * Supports {{variable}} syntax for variable substitution
 */
export class TemplateEngine {
  /**
   * Render a template with variables
   * @param templatePath - Path to the template file
   * @param variables - Variables to substitute in the template
   * @returns Rendered template string
   */
  static async renderTemplate(
    templatePath: string,
    variables: Record<string, unknown>,
  ): Promise<string> {
    try {
      const content = await fs.readFile(templatePath, "utf8");
      return this.renderString(content, variables);
    } catch (err) {
      logger.error({ err }, `Failed to render template: ${templatePath}`);
      throw err;
    }
  }

  /**
   * Render a template string with variables
   * @param template - Template string
   * @param variables - Variables to substitute in the template
   * @returns Rendered template string
   */
  static renderString(
    template: string,
    variables: Record<string, unknown>,
  ): string {
    let result = template;

    // Replace {{variable}} patterns
    result = result.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
      const trimmedKey = key.trim();
      const value = this.getNestedValue(variables, trimmedKey);

      if (value === undefined) {
        logger.debug(`Template variable not found: ${trimmedKey}`);
        return match; // Keep original if variable not found
      }

      return String(value);
    });

    return result;
  }

  /**
   * Get nested value from object using dot notation
   * @param obj - Object to get value from
   * @param path - Dot-separated path to value
   * @returns Value at path, or undefined if not found
   */
  private static getNestedValue(
    obj: Record<string, unknown>,
    path: string,
  ): unknown {
    const keys = path.split(".");
    let current: unknown = obj;

    for (const key of keys) {
      if (current === null || typeof current !== "object") {
        return undefined;
      }

      current = (current as Record<string, unknown>)[key];
    }

    return current;
  }

  /**
   * Render multiple templates from a directory
   * @param templateDir - Directory containing template files
   * @param variables - Variables to substitute in templates
   * @returns Map of template names to rendered content
   */
  static async renderTemplatesFromDir(
    templateDir: string,
    variables: Record<string, unknown>,
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    try {
      const entries = await fs.readdir(templateDir, { withFileTypes: true });

      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) {
          continue;
        }

        const templatePath = path.join(templateDir, entry.name);
        const content = await this.renderTemplate(templatePath, variables);
        results.set(entry.name, content);
      }
    } catch (err) {
      logger.error(
        { err },
        `Failed to render templates from directory: ${templateDir}`,
      );
    }

    return results;
  }
}
