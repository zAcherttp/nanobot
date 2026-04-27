import { exec } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../utils/logger";

const execAsync = promisify(exec);

export interface Requirements {
  bins?: string[];
  env?: string[];
}

export interface RequirementCheckResult {
  satisfied: boolean;
  missingBins: string[];
  missingEnv: string[];
}

/**
 * Requirements checker for tools and skills
 */
export class RequirementsChecker {
  /**
   * Check if all requirements are satisfied
   * @param requirements - Requirements to check
   * @returns Result of requirement check
   */
  static async checkRequirements(
    requirements: Requirements,
  ): Promise<RequirementCheckResult> {
    const missingBins: string[] = [];
    const missingEnv: string[] = [];

    // Check binary requirements
    if (requirements.bins) {
      for (const binary of requirements.bins) {
        const available = await this.checkBinary(binary);
        if (!available) {
          missingBins.push(binary);
        }
      }
    }

    // Check environment variable requirements
    if (requirements.env) {
      for (const envVar of requirements.env) {
        const available = this.checkEnvVar(envVar);
        if (!available) {
          missingEnv.push(envVar);
        }
      }
    }

    return {
      satisfied: missingBins.length === 0 && missingEnv.length === 0,
      missingBins,
      missingEnv,
    };
  }

  /**
   * Check if a binary is available in PATH
   * @param binary - Binary name to check
   * @returns True if binary is available
   */
  static async checkBinary(binary: string): Promise<boolean> {
    try {
      // Use 'where' on Windows, 'which' on Unix
      const command =
        process.platform === "win32" ? `where ${binary}` : `which ${binary}`;
      await execAsync(command);
      return true;
    } catch (err) {
      logger.debug(`Binary not found: ${binary}`);
      return false;
    }
  }

  /**
   * Check if an environment variable is set
   * @param envVar - Environment variable name
   * @returns True if environment variable is set and non-empty
   */
  static checkEnvVar(envVar: string): boolean {
    const value = process.env[envVar];
    const available = value !== undefined && value !== "";
    if (!available) {
      logger.debug(`Environment variable not set: ${envVar}`);
    }
    return available;
  }

  /**
   * Get list of missing requirements
   * @param requirements - Requirements to check
   * @returns Array of missing requirement descriptions
   */
  static async getMissingRequirements(
    requirements: Requirements,
  ): Promise<string[]> {
    const result = await this.checkRequirements(requirements);
    const missing: string[] = [];

    for (const bin of result.missingBins) {
      missing.push(`Binary '${bin}' not found in PATH`);
    }

    for (const envVar of result.missingEnv) {
      missing.push(`Environment variable '${envVar}' not set`);
    }

    return missing;
  }

  /**
   * Format requirement check result as a user-friendly message
   * @param result - Requirement check result
   * @returns Formatted message
   */
  static formatResult(result: RequirementCheckResult): string {
    if (result.satisfied) {
      return "All requirements are satisfied.";
    }

    const parts: string[] = ["Missing requirements:"];

    if (result.missingBins.length > 0) {
      parts.push(`  Binaries: ${result.missingBins.join(", ")}`);
    }

    if (result.missingEnv.length > 0) {
      parts.push(`  Environment variables: ${result.missingEnv.join(", ")}`);
    }

    return parts.join("\n");
  }
}
