import fs from 'fs';
import path from 'path';

export type ServiceKind = 'primary' | 'codex' | 'review';

export interface ServiceDef {
  /** Stable topology kind used by setup/verify logic */
  kind: ServiceKind;
  /** systemd unit name / nohup script name */
  name: string;
  /** launchd label */
  launchdLabel: string;
  /** Human-readable description for systemd/launchd */
  description: string;
  /** Log file prefix (e.g. "ejclaw" → logs/ejclaw.log) */
  logName: string;
  /** Absolute path to EnvironmentFile (systemd) — loaded before Environment= */
  environmentFile?: string;
  /** Extra Environment= lines for systemd / env dict entries for launchd */
  extraEnv?: Record<string, string>;
}

interface ServiceTemplate {
  kind: ServiceKind;
  name: string;
  launchdLabel: string;
  description: string;
  logName: string;
  envFileName?: string;
  assistantName?: string;
}

const SERVICE_TEMPLATES: ServiceTemplate[] = [
  {
    kind: 'primary',
    name: 'ejclaw',
    launchdLabel: 'com.ejclaw',
    description: 'EJClaw Personal Assistant (Claude Code)',
    logName: 'ejclaw',
  },
  {
    kind: 'codex',
    name: 'ejclaw-codex',
    launchdLabel: 'com.ejclaw-codex',
    description: 'EJClaw Codex Assistant',
    logName: 'ejclaw-codex',
    envFileName: '.env.codex',
    assistantName: 'codex',
  },
  {
    kind: 'review',
    name: 'ejclaw-review',
    launchdLabel: 'com.ejclaw-review',
    description: 'EJClaw Codex Review Assistant',
    logName: 'ejclaw-review',
    envFileName: '.env.codex-review',
    assistantName: 'codex',
  },
];

function materializeServiceDef(
  projectRoot: string,
  template: ServiceTemplate,
): ServiceDef | null {
  const environmentFile = template.envFileName
    ? path.join(projectRoot, template.envFileName)
    : undefined;

  if (environmentFile && !fs.existsSync(environmentFile)) {
    return null;
  }

  return {
    kind: template.kind,
    name: template.name,
    launchdLabel: template.launchdLabel,
    description: template.description,
    logName: template.logName,
    environmentFile,
    extraEnv: template.assistantName
      ? {
          ASSISTANT_NAME: template.assistantName,
        }
      : undefined,
  };
}

export function getServiceDefs(projectRoot: string): ServiceDef[] {
  return SERVICE_TEMPLATES.flatMap((template) => {
    const def = materializeServiceDef(projectRoot, template);
    return def ? [def] : [];
  });
}

export function getConfiguredServiceNames(projectRoot: string): string[] {
  return getServiceDefs(projectRoot).map((def) => def.name);
}
