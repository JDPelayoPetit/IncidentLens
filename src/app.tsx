import { Suspense, useCallback, useState, useEffect, useRef } from "react";
import { useAgent } from "agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import { getToolName, isToolUIPart, type UIMessage } from "ai";
import { isAnalysisTruncated, CHAT_LIMITS } from "./analysis-utils";
import type {
  IncidentLensAgent,
  IncidentSubmission,
  IncidentAgentState
} from "./server";

const INCIDENT_LIMITS = {
  TITLE_MAX_LENGTH: 160,
  DESCRIPTION_MAX_LENGTH: 2000,
  LOGS_MAX_LENGTH: 12000,
  RECENT_CHANGES_MAX_LENGTH: 1000,
  SERVICES_MAX_COUNT: 20,
  SERVICE_ITEM_MAX_LENGTH: 120
} as const;
import {
  Badge,
  Button,
  InputArea,
  PoweredByCloudflare,
  Surface,
  Switch,
  Text
} from "@cloudflare/kumo";
import { Toasty } from "@cloudflare/kumo/components/toast";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  PaperPlaneRightIcon,
  StopIcon,
  TrashIcon,
  GearIcon,
  ChatCircleDotsIcon,
  CircleIcon,
  MoonIcon,
  SunIcon,
  CheckCircleIcon,
  XCircleIcon,
  BrainIcon,
  CaretDownIcon,
  CaretUpIcon,
  BugIcon,
  WarningIcon,
  FileTextIcon,
  PlusIcon
} from "@phosphor-icons/react";

// ── Realistic Sample Incident for Quick Evaluation ────────────────────

const SAMPLE_INCIDENT: IncidentSubmission = {
  title: "Elevated 504 Gateway Timeouts on Checkout API",
  description:
    "Error rate on checkout endpoints spiked from 0.05% to 19.2% over the last 15 minutes. Upstream payment services are returning connection timeouts, leading to cascade failures in the checkout worker pool.",
  affectedServices: ["api-gateway", "checkout-service", "payment-service"],
  recentChanges:
    "Deployed checkout-service v3.4.1 25 minutes ago with revised database connection pool settings (maxConnections lowered from 100 to 25).",
  logs: `[2026-10-20T19:24:01.124Z] ERROR [api-gateway] upstream request timeout: POST /v1/checkout (status: 504, latency: 10002ms)
[2026-10-20T19:24:02.451Z] WARN  [checkout-service] pool: connection pool exhausted (active: 25, idle: 0, waiting: 84)
[2026-10-20T19:24:05.890Z] ERROR [checkout-service] uncaught exception in payment client: TimeoutError: Connection acquisition timed out after 5000ms
    at Pool.acquire (/app/node_modules/pg-pool/index.js:142:18)
    at async PaymentService.charge (/app/src/services/payment.ts:45:12)
[2026-10-20T19:24:10.012Z] ERROR [api-gateway] circuit breaker tripped for host payment.internal.svc (failure_rate: 0.32)`
};

// ── Small Components ──────────────────────────────────────────────────

function ThemeToggle() {
  const [dark, setDark] = useState(
    () => document.documentElement.getAttribute("data-mode") === "dark"
  );

  const toggle = useCallback(() => {
    const next = !dark;
    setDark(next);
    const mode = next ? "dark" : "light";
    document.documentElement.setAttribute("data-mode", mode);
    document.documentElement.style.colorScheme = mode;
    localStorage.setItem("theme", mode);
  }, [dark]);

  return (
    <Button
      variant="secondary"
      shape="square"
      icon={dark ? <SunIcon size={16} /> : <MoonIcon size={16} />}
      onClick={toggle}
      aria-label="Toggle theme"
    />
  );
}

function ToolIO({ label, value }: { label: string; value: unknown }) {
  if (value === undefined || value === null) return null;
  const text =
    typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (!text) return null;
  return (
    <div className="mt-1">
      <Text size="xs" variant="secondary" bold>
        {label}
      </Text>
      <pre className="mt-0.5 font-mono text-xs text-kumo-subtle whitespace-pre-wrap overflow-auto max-h-64">
        {text}
      </pre>
    </div>
  );
}

function ToolPartView({
  part,
  addToolApprovalResponse
}: {
  part: UIMessage["parts"][number];
  addToolApprovalResponse: (response: {
    id: string;
    approved: boolean;
  }) => void;
}) {
  if (!isToolUIPart(part)) return null;
  const toolName = getToolName(part);

  if (part.state === "output-available") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring ring-kumo-line">
          <div className="flex items-center gap-2 mb-1">
            <GearIcon size={14} className="text-kumo-inactive" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="secondary">Done</Badge>
          </div>
          <ToolIO label="Input" value={part.input} />
          <ToolIO label="Output" value={part.output} />
        </Surface>
      </div>
    );
  }

  if ("approval" in part && part.state === "approval-requested") {
    const approvalId = (part.approval as { id?: string })?.id;
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-3 rounded-xl ring-2 ring-kumo-warning">
          <div className="flex items-center gap-2 mb-2">
            <GearIcon size={14} className="text-kumo-warning" />
            <Text size="sm" bold>
              Approval needed: {toolName}
            </Text>
          </div>
          <div className="font-mono mb-3">
            <Text size="xs" variant="secondary">
              {JSON.stringify(part.input, null, 2)}
            </Text>
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              icon={<CheckCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: true });
                }
              }}
            >
              Approve
            </Button>
            <Button
              variant="secondary"
              size="sm"
              icon={<XCircleIcon size={14} />}
              onClick={() => {
                if (approvalId) {
                  addToolApprovalResponse({ id: approvalId, approved: false });
                }
              }}
            >
              Reject
            </Button>
          </div>
        </Surface>
      </div>
    );
  }

  if (part.state === "output-error") {
    return (
      <div className="flex justify-start">
        <Surface className="max-w-[85%] px-4 py-2.5 rounded-xl ring-2 ring-kumo-danger">
          <div className="flex items-center gap-2 mb-1">
            <XCircleIcon size={14} className="text-kumo-danger" />
            <Text size="xs" variant="secondary" bold>
              {toolName}
            </Text>
            <Badge variant="destructive">Error</Badge>
          </div>
          <div className="font-mono">
            <Text size="xs" variant="secondary">
              {part.errorText || "Tool call failed"}
            </Text>
          </div>
        </Surface>
      </div>
    );
  }

  return null;
}

// ── Incident Submission Form ──────────────────────────────────────────

interface IncidentFormProps {
  connected: boolean;
  isSubmitting: boolean;
  onSubmit: (submission: IncidentSubmission) => Promise<boolean>;
  onCancel?: () => void;
  serverErrors: string[];
}

function IncidentForm({
  connected,
  isSubmitting,
  onSubmit,
  onCancel,
  serverErrors
}: IncidentFormProps) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [logs, setLogs] = useState("");
  const [recentChanges, setRecentChanges] = useState("");
  const [affectedServices, setAffectedServices] = useState("");
  const [clientErrors, setClientErrors] = useState<string[]>([]);

  // Parse services for live count
  const parsedServices = affectedServices
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const titleOver = title.length > INCIDENT_LIMITS.TITLE_MAX_LENGTH;
  const descOver = description.length > INCIDENT_LIMITS.DESCRIPTION_MAX_LENGTH;
  const logsOver = logs.length > INCIDENT_LIMITS.LOGS_MAX_LENGTH;
  const changesOver =
    recentChanges.length > INCIDENT_LIMITS.RECENT_CHANGES_MAX_LENGTH;
  const servicesCountOver =
    parsedServices.length > INCIDENT_LIMITS.SERVICES_MAX_COUNT;
  const servicesItemOver = parsedServices.some(
    (s) => s.length > INCIDENT_LIMITS.SERVICE_ITEM_MAX_LENGTH
  );

  const isFormInvalid =
    !description.trim() ||
    !logs.trim() ||
    titleOver ||
    descOver ||
    logsOver ||
    changesOver ||
    servicesCountOver ||
    servicesItemOver;

  const handleLoadSample = () => {
    setTitle(SAMPLE_INCIDENT.title || "");
    setDescription(SAMPLE_INCIDENT.description);
    setLogs(SAMPLE_INCIDENT.logs);
    setRecentChanges(SAMPLE_INCIDENT.recentChanges || "");
    setAffectedServices(SAMPLE_INCIDENT.affectedServices?.join(", ") || "");
    setClientErrors([]);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const errs: string[] = [];

    if (!description.trim()) {
      errs.push("Incident description is required.");
    }
    if (!logs.trim()) {
      errs.push("Logs or diagnostic evidence are required.");
    }
    if (titleOver) {
      errs.push(`Title exceeds limit of ${INCIDENT_LIMITS.TITLE_MAX_LENGTH} characters.`);
    }
    if (descOver) {
      errs.push(`Description exceeds limit of ${INCIDENT_LIMITS.DESCRIPTION_MAX_LENGTH} characters.`);
    }
    if (logsOver) {
      errs.push(`Logs exceed limit of ${INCIDENT_LIMITS.LOGS_MAX_LENGTH} characters.`);
    }
    if (changesOver) {
      errs.push(`Recent changes exceeds limit of ${INCIDENT_LIMITS.RECENT_CHANGES_MAX_LENGTH} characters.`);
    }
    if (servicesCountOver) {
      errs.push(`Affected services list exceeds limit of ${INCIDENT_LIMITS.SERVICES_MAX_COUNT} entries.`);
    }
    if (servicesItemOver) {
      errs.push(`An affected service name exceeds the ${INCIDENT_LIMITS.SERVICE_ITEM_MAX_LENGTH} character limit.`);
    }

    if (errs.length > 0) {
      setClientErrors(errs);
      return;
    }

    setClientErrors([]);
    const submission: IncidentSubmission = {
      title: title.trim() || undefined,
      description: description.trim(),
      logs: logs, // Content and formatting strictly preserved
      recentChanges: recentChanges.trim() || undefined,
      affectedServices: parsedServices.length > 0 ? parsedServices : undefined
    };

    await onSubmit(submission);
  };

  const displayedErrors = [...clientErrors, ...serverErrors];

  return (
    <Surface className="p-5 rounded-2xl ring ring-kumo-line bg-kumo-base shadow-sm space-y-4">
      <div className="flex items-center justify-between pb-3 border-b border-kumo-line">
        <div className="flex items-center gap-2">
          <FileTextIcon size={20} className="text-kumo-accent" />
          <Text size="base" bold>
            New Incident Submission
          </Text>
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={handleLoadSample}
            disabled={isSubmitting}
          >
            Load Sample Incident
          </Button>
          {onCancel && (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onCancel}
              disabled={isSubmitting}
            >
              Cancel
            </Button>
          )}
        </div>
      </div>

      {displayedErrors.length > 0 && (
        <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-600 dark:text-red-400 space-y-1">
          <div className="flex items-center gap-1.5 font-semibold">
            <WarningIcon size={14} />
            <span>Validation Issues</span>
          </div>
          <ul className="list-disc list-inside space-y-0.5">
            {displayedErrors.map((err, i) => (
              <li key={i}>{err}</li>
            ))}
          </ul>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Title */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label htmlFor="inc-title" className="text-xs font-medium text-kumo-default">
              Incident Title (Optional)
            </label>
            <span
              className={`text-[11px] ${
                titleOver ? "text-red-500 font-bold" : "text-kumo-subtle"
              }`}
            >
              {title.length} / {INCIDENT_LIMITS.TITLE_MAX_LENGTH}
            </span>
          </div>
          <input
            id="inc-title"
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={isSubmitting}
            placeholder="e.g., Elevated 504 Gateway Timeouts on Checkout API"
            className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-elevated text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
          />
        </div>

        {/* Affected Services */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label htmlFor="inc-services" className="text-xs font-medium text-kumo-default">
              Affected Services (Optional, comma-separated)
            </label>
            <span
              className={`text-[11px] ${
                servicesCountOver ? "text-red-500 font-bold" : "text-kumo-subtle"
              }`}
            >
              {parsedServices.length} / {INCIDENT_LIMITS.SERVICES_MAX_COUNT} services
            </span>
          </div>
          <input
            id="inc-services"
            type="text"
            value={affectedServices}
            onChange={(e) => setAffectedServices(e.target.value)}
            disabled={isSubmitting}
            placeholder="e.g., api-gateway, checkout-service, payment-service"
            className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-elevated text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent"
          />
        </div>

        {/* Description */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label htmlFor="inc-desc" className="text-xs font-medium text-kumo-default">
              Incident Description <span className="text-red-500">*</span>
            </label>
            <span
              className={`text-[11px] ${
                descOver ? "text-red-500 font-bold" : "text-kumo-subtle"
              }`}
            >
              {description.length} / {INCIDENT_LIMITS.DESCRIPTION_MAX_LENGTH}
            </span>
          </div>
          <textarea
            id="inc-desc"
            rows={3}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={isSubmitting}
            placeholder="Observed symptoms, alert triggers, or user-facing impact..."
            className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-elevated text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent resize-y"
          />
        </div>

        {/* Recent Changes */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label htmlFor="inc-changes" className="text-xs font-medium text-kumo-default">
              Recent Changes (Optional)
            </label>
            <span
              className={`text-[11px] ${
                changesOver ? "text-red-500 font-bold" : "text-kumo-subtle"
              }`}
            >
              {recentChanges.length} / {INCIDENT_LIMITS.RECENT_CHANGES_MAX_LENGTH}
            </span>
          </div>
          <textarea
            id="inc-changes"
            rows={2}
            value={recentChanges}
            onChange={(e) => setRecentChanges(e.target.value)}
            disabled={isSubmitting}
            placeholder="Deployments, config changes, feature flags, or infra migrations..."
            className="w-full px-3 py-2 text-sm rounded-lg border border-kumo-line bg-kumo-elevated text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent resize-y"
          />
        </div>

        {/* Logs / Diagnostic Evidence */}
        <div>
          <div className="flex justify-between items-center mb-1">
            <label htmlFor="inc-logs" className="text-xs font-medium text-kumo-default">
              Logs & Diagnostic Evidence <span className="text-red-500">*</span>
            </label>
            <span
              className={`text-[11px] ${
                logsOver ? "text-red-500 font-bold" : "text-kumo-subtle"
              }`}
            >
              {logs.length} / {INCIDENT_LIMITS.LOGS_MAX_LENGTH}
            </span>
          </div>
          <textarea
            id="inc-logs"
            rows={8}
            value={logs}
            onChange={(e) => setLogs(e.target.value)}
            disabled={isSubmitting}
            placeholder="Paste raw log excerpts, stack traces, or metrics (exact whitespace and line breaks are preserved)..."
            className="w-full px-3 py-2 text-xs font-mono rounded-lg border border-kumo-line bg-kumo-elevated text-kumo-default placeholder:text-kumo-inactive focus:outline-none focus:ring-1 focus:ring-kumo-accent resize-y whitespace-pre"
          />
        </div>

        {/* Action Button */}
        <div className="flex justify-end pt-2">
          <Button
            type="submit"
            variant="primary"
            disabled={!connected || isSubmitting || isFormInvalid}
            icon={isSubmitting ? <GearIcon size={16} className="animate-spin" /> : <PaperPlaneRightIcon size={16} />}
          >
            {isSubmitting ? "Submitting Incident..." : "Start Root-Cause Analysis"}
          </Button>
        </div>
      </form>
    </Surface>
  );
}

// ── Active Incident Header Banner ─────────────────────────────────────

interface ActiveIncidentBannerProps {
  incident: IncidentSubmission;
  status: "idle" | "analyzing" | "ready" | "incomplete";
  onNewIncident: () => void;
}

function ActiveIncidentBanner({
  incident,
  status,
  onNewIncident
}: ActiveIncidentBannerProps) {
  const [expanded, setExpanded] = useState(false);

  return (
    <Surface className="mb-4 rounded-xl ring ring-kumo-line bg-kumo-base overflow-hidden">
      <div className="p-3.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5 min-w-0">
          <FileTextIcon size={18} className="text-kumo-accent shrink-0" />
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-semibold text-kumo-default truncate">
                {incident.title || "Active Incident"}
              </span>
              <Badge
                variant={
                  status === "analyzing"
                    ? "secondary"
                    : status === "incomplete"
                      ? "warning"
                      : "primary"
                }
              >
                {status === "analyzing" ? (
                  <span className="flex items-center gap-1">
                    <GearIcon size={10} className="animate-spin" /> Analyzing
                  </span>
                ) : status === "incomplete" ? (
                  "Incomplete"
                ) : (
                  "Ready"
                )}
              </Badge>
            </div>
            {incident.affectedServices && incident.affectedServices.length > 0 && (
              <div className="flex gap-1.5 mt-1 flex-wrap">
                {incident.affectedServices.map((svc) => (
                  <span
                    key={svc}
                    className="text-[10px] px-1.5 py-0.5 rounded bg-kumo-control text-kumo-subtle font-mono"
                  >
                    {svc}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 ml-3">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setExpanded(!expanded)}
            icon={expanded ? <CaretUpIcon size={14} /> : <CaretDownIcon size={14} />}
          >
            {expanded ? "Hide Evidence" : "View Evidence"}
          </Button>
          <Button
            variant="secondary"
            size="sm"
            icon={<PlusIcon size={14} />}
            onClick={onNewIncident}
          >
            New Incident
          </Button>
        </div>
      </div>

      {expanded && (
        <div className="px-4 pb-4 pt-2 border-t border-kumo-line bg-kumo-elevated space-y-3 text-xs">
          <div>
            <Text size="xs" variant="secondary" bold>
              Description
            </Text>
            <p className="mt-0.5 text-kumo-default whitespace-pre-wrap">
              {incident.description}
            </p>
          </div>
          {incident.recentChanges && (
            <div>
              <Text size="xs" variant="secondary" bold>
                Recent Changes
              </Text>
              <p className="mt-0.5 text-kumo-default whitespace-pre-wrap">
                {incident.recentChanges}
              </p>
            </div>
          )}
          <div>
            <Text size="xs" variant="secondary" bold>
              Pasted Diagnostic Logs & Evidence
            </Text>
            <pre className="mt-1 p-2.5 rounded-lg bg-kumo-control text-kumo-default font-mono text-[11px] whitespace-pre overflow-x-auto max-h-56">
              {incident.logs}
            </pre>
          </div>
        </div>
      )}
    </Surface>
  );
}

// ── Main Chat Application ─────────────────────────────────────────────

function Chat() {
  const [connected, setConnected] = useState(false);
  const [input, setInput] = useState("");
  const [showDebug, setShowDebug] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [serverErrors, setServerErrors] = useState<string[]>([]);
  const [clearError, setClearError] = useState<string | null>(null);
  const [formResetKey, setFormResetKey] = useState(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const agent = useAgent<IncidentLensAgent, IncidentAgentState>({
    agent: "IncidentLensAgent",
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
    onError: useCallback(
      (error: Event) => console.error("WebSocket error:", error),
      []
    )
  });

  const {
    messages,
    sendMessage,
    clearHistory,
    addToolApprovalResponse,
    stop,
    status,
    isStreaming: agentIsStreaming
  } = useAgentChat({
    agent,
    experimental_throttle: 100
  });

  const activeIncident = agent.state?.activeIncident;
  const incidentStatus = agent.state?.status || "idle";
  const isStreaming =
    agentIsStreaming ||
    status === "streaming" ||
    status === "submitted" ||
    incidentStatus === "analyzing" ||
    isSubmitting;

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Re-focus the input after streaming ends
  useEffect(() => {
    if (!isStreaming && textareaRef.current) {
      textareaRef.current.focus();
    }
  }, [isStreaming]);

  // Handler for structured incident submission via RPC
  const handleIncidentSubmit = async (submission: IncidentSubmission): Promise<boolean> => {
    setIsSubmitting(true);
    setServerErrors([]);
    setClearError(null);
    try {
      const result = await agent.stub.submitIncident(submission);
      if (!result.success) {
        setServerErrors(result.errors);
        return false;
      }
      setShowForm(false);
      return true;
    } catch (err: unknown) {
      console.error("Incident submission RPC failed:", err);
      setServerErrors([
        err instanceof Error ? err.message : "Failed to communicate with incident agent."
      ]);
      return false;
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleClear = async () => {
    setClearError(null);
    setServerErrors([]);
    setInput("");
    setShowForm(false);
    setFormResetKey((k) => k + 1);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    try {
      // 1. Halt any active stream reception on the client
      stop();

      // 2. Clear incident state on server and abort in-flight analysis
      const res = await agent.stub.clearIncident();
      if (!res.success) {
        setClearError(res.error || "Failed to clear incident context on server.");
        return;
      }

      // 3. Clear conversation history and notify server to delete persisted messages
      clearHistory();
    } catch (err: unknown) {
      const msg =
        err instanceof Error ? err.message : "Failed to communicate with incident agent to clear state.";
      console.error("Failed to clear incident state on server:", err);
      setClearError(msg);
    }
  };

  const send = useCallback(async () => {
    const text = input.trim();
    if (!text || isStreaming || text.length > CHAT_LIMITS.FOLLOW_UP_MAX_LENGTH) return;
    setInput("");

    sendMessage({
      role: "user",
      parts: [{ type: "text", text }]
    });
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, isStreaming, sendMessage]);


  return (
    <div className="flex flex-col h-screen bg-kumo-elevated relative">
      {/* Header */}
      <header className="px-5 py-4 bg-kumo-base border-b border-kumo-line">
        <div className="max-w-3xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-lg font-semibold text-kumo-default">
              IncidentLens
            </h1>
            <Badge variant="secondary">
              <ChatCircleDotsIcon size={12} weight="bold" className="mr-1" />
              Incident Triage & RCA
            </Badge>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-1.5">
              <CircleIcon
                size={8}
                weight="fill"
                className={connected ? "text-kumo-success" : "text-kumo-danger"}
              />
              <Text size="xs" variant="secondary">
                {connected ? "Connected" : "Disconnected"}
              </Text>
            </div>
            <div className="flex items-center gap-1.5">
              <BugIcon size={14} className="text-kumo-inactive" />
              <Switch
                checked={showDebug}
                onCheckedChange={setShowDebug}
                size="sm"
                aria-label="Toggle debug mode"
              />
            </div>
            <ThemeToggle />
            <Button
              variant="secondary"
              icon={<TrashIcon size={16} />}
              onClick={handleClear}
              aria-label="Clear conversation and incident state"
            >
              Clear
            </Button>
          </div>
        </div>
      </header>

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-5 py-6 space-y-5">
          {/* Clear Error Alert */}
          {clearError && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-600 dark:text-red-400 flex items-center justify-between">
              <div className="flex items-center gap-1.5 font-semibold">
                <WarningIcon size={14} />
                <span>{clearError}</span>
              </div>
              <button
                type="button"
                onClick={() => setClearError(null)}
                className="text-[11px] underline opacity-80 hover:opacity-100 ml-3"
              >
                Dismiss
              </button>
            </div>
          )}

          {/* Active Incident Summary Card */}
          {activeIncident && !showForm && (
            <ActiveIncidentBanner
              incident={activeIncident}
              status={incidentStatus}
              onNewIncident={() => setShowForm(true)}
            />
          )}

          {/* Form shown if no messages yet or if user clicked "New Incident" */}
          {(messages.length === 0 || showForm) && (
            <IncidentForm
              key={formResetKey}
              connected={connected}
              isSubmitting={isSubmitting || isStreaming}
              onSubmit={handleIncidentSubmit}
              onCancel={messages.length > 0 ? () => setShowForm(false) : undefined}
              serverErrors={serverErrors}
            />
          )}

          {/* Messages */}
          {messages.map((message: UIMessage, index: number) => {
            const isUser = message.role === "user";
            const isLastAssistant =
              message.role === "assistant" && index === messages.length - 1;
            const hasStreamingParts =
              message.parts?.some(
                (p) => "state" in p && p.state === "streaming"
              ) ?? false;
            const isActivelyStreaming =
              (isLastAssistant && isStreaming) || hasStreamingParts;
            const isTruncated =
              !isActivelyStreaming && isAnalysisTruncated(message);
            const meta =
              message.metadata && typeof message.metadata === "object"
                ? (message.metadata as Record<string, unknown>)
                : undefined;
            const finishReason =
              typeof meta?.finishReason === "string" ? meta.finishReason : undefined;
            const isAssistant = message.role === "assistant";
            const isError =
              isAssistant && !isActivelyStreaming && finishReason === "error";
            const isAborted =
              isAssistant &&
              !isActivelyStreaming &&
              (finishReason === "abort" || finishReason === "cancelled");

            return (
              <div key={message.id} className="space-y-2">
                {showDebug && (
                  <pre className="text-[11px] text-kumo-subtle bg-kumo-control rounded-lg p-3 overflow-auto max-h-64">
                    {JSON.stringify(message, null, 2)}
                  </pre>
                )}

                {message.parts.map((part, i) => {
                  const key = `${message.id}-${i}`;

                  if (isToolUIPart(part)) {
                    return (
                      <ToolPartView
                        key={key}
                        part={part}
                        addToolApprovalResponse={addToolApprovalResponse}
                      />
                    );
                  }

                  if (part.type === "reasoning") {
                    if (!part.text.trim()) return null;
                    const isDone = part.state === "done" || !isStreaming;
                    return (
                      <div key={key} className="flex justify-start">
                        <details className="max-w-[85%] w-full">
                          <summary className="flex items-center gap-2 cursor-pointer px-3 py-2 rounded-lg bg-purple-500/10 border border-purple-500/20 text-sm select-none">
                            <BrainIcon size={14} className="text-purple-400" />
                            <span className="font-medium text-kumo-default">
                              Investigation Reasoning
                            </span>
                            {isDone ? (
                              <span className="text-xs text-kumo-success">
                                Complete
                              </span>
                            ) : (
                              <span className="text-xs text-kumo-brand">
                                Analyzing telemetry...
                              </span>
                            )}
                            <CaretDownIcon
                              size={14}
                              className="ml-auto text-kumo-inactive"
                            />
                          </summary>
                          <pre className="mt-2 px-3 py-2 rounded-lg bg-kumo-control text-xs text-kumo-default whitespace-pre-wrap overflow-auto max-h-64">
                            {part.text}
                          </pre>
                        </details>
                      </div>
                    );
                  }

                  if (part.type === "text") {
                    if (!part.text) return null;

                    if (isUser) {
                      return (
                        <div key={key} className="flex justify-end">
                          <div className="max-w-[85%] px-4 py-2.5 rounded-2xl rounded-br-md bg-kumo-contrast text-kumo-inverse leading-relaxed">
                            {part.text}
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={key} className="flex justify-start">
                        <div className="max-w-[85%] rounded-2xl rounded-bl-md bg-kumo-base text-kumo-default leading-relaxed border border-kumo-line shadow-sm">
                          <Streamdown
                            className="sd-theme rounded-2xl rounded-bl-md p-4"
                            plugins={{ code }}
                            controls={false}
                            isAnimating={isLastAssistant && isStreaming}
                          >
                            {part.text}
                          </Streamdown>
                        </div>
                      </div>
                    );
                  }

                  return null;
                })}

                {isTruncated && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] w-full p-3.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-800 dark:text-amber-200">
                      <div className="flex items-center gap-2 mb-1.5">
                        <WarningIcon size={16} className="text-amber-500 shrink-0" />
                        <span className="font-semibold text-kumo-default">
                          Analysis Incomplete
                        </span>
                        <Badge variant="warning">Incomplete</Badge>
                      </div>
                      <p className="text-kumo-subtle leading-normal">
                        The analysis reached the token limit before completing all diagnostic sections. The partial findings above are preserved, but the report is incomplete. You can ask a follow-up question below to explore specific hypotheses or remaining diagnostic checks.
                      </p>
                    </div>
                  </div>
                )}

                {isError && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] w-full p-3.5 rounded-xl bg-red-500/10 border border-red-500/30 text-xs text-red-700 dark:text-red-300">
                      <div className="flex items-center gap-2 mb-1.5">
                        <XCircleIcon size={16} className="text-red-500 shrink-0" />
                        <span className="font-semibold text-kumo-default">
                          Analysis Failed
                        </span>
                        <Badge variant="destructive">Error</Badge>
                      </div>
                      <p className="text-kumo-subtle leading-normal">
                        The analysis stopped due to an error. You can retry submitting the incident or ask a follow-up question.
                      </p>
                    </div>
                  </div>
                )}

                {isAborted && (
                  <div className="flex justify-start">
                    <div className="max-w-[85%] w-full p-3.5 rounded-xl bg-kumo-control border border-kumo-line text-xs text-kumo-default">
                      <div className="flex items-center gap-2 mb-1.5">
                        <StopIcon size={16} className="text-kumo-inactive shrink-0" />
                        <span className="font-semibold text-kumo-default">
                          Analysis Cancelled
                        </span>
                        <Badge variant="secondary">Cancelled</Badge>
                      </div>
                      <p className="text-kumo-subtle leading-normal">
                        The analysis was stopped before completion.
                      </p>
                    </div>
                  </div>
                )}
              </div>
            );
          })}

          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Follow-up Chat Input */}
      <div className="border-t border-kumo-line bg-kumo-base">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            send();
          }}
          className="max-w-3xl mx-auto px-5 py-4"
        >
          <div className="flex items-end gap-3 rounded-xl border border-kumo-line bg-kumo-base p-3 shadow-sm focus-within:ring-2 focus-within:ring-kumo-ring focus-within:border-transparent transition-shadow">
            <InputArea
              ref={textareaRef}
              value={input}
              onValueChange={setInput}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
              onInput={(e) => {
                const el = e.currentTarget;
                el.style.height = "auto";
                el.style.height = `${el.scrollHeight}px`;
              }}
              placeholder={
                activeIncident
                  ? incidentStatus === "incomplete"
                    ? "Ask a follow-up question to complete diagnostic steps or probe specific hypotheses..."
                    : "Ask follow-up diagnostic questions or probe specific hypotheses..."
                  : "Submit an incident above or ask a question..."
              }
              disabled={!connected || isStreaming}
              rows={1}
              className="flex-1 ring-0! focus:ring-0! shadow-none! bg-transparent! outline-none! resize-none max-h-40"
            />
            {input.length > 1800 && (
              <span
                className={`text-[11px] self-center mr-1 ${
                  input.length > CHAT_LIMITS.FOLLOW_UP_MAX_LENGTH
                    ? "text-red-500 font-bold"
                    : "text-kumo-subtle"
                }`}
              >
                {input.length} / {CHAT_LIMITS.FOLLOW_UP_MAX_LENGTH}
              </span>
            )}
            {isStreaming ? (
              <Button
                type="button"
                variant="secondary"
                shape="square"
                aria-label="Stop generation"
                icon={<StopIcon size={18} />}
                onClick={stop}
                className="mb-0.5"
              />
            ) : (
              <Button
                type="submit"
                variant="primary"
                shape="square"
                aria-label="Send message"
                disabled={!input.trim() || !connected || input.length > CHAT_LIMITS.FOLLOW_UP_MAX_LENGTH}
                icon={<PaperPlaneRightIcon size={18} />}
                className="mb-0.5"
              />
            )}
          </div>
        </form>
        <div className="flex justify-center pb-3">
          <PoweredByCloudflare href="https://developers.cloudflare.com/agents/" />
        </div>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <Toasty>
      <Suspense
        fallback={
          <div className="flex items-center justify-center h-screen text-kumo-inactive">
            Loading IncidentLens...
          </div>
        }
      >
        <Chat />
      </Suspense>
    </Toasty>
  );
}
