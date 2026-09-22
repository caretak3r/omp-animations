/**
 * Type adapter for host dependency (@oh-my-pi/pi-coding-agent).
 *
 * Host subpath imports carry no semver commitment. This module re-exports every
 * type the plugin consumes so a host refactor breaks once here, not across 21 files.
 *
 * See plan 023 and the Biome fence at biome.json (noRestrictedImports override).
 */

export type {
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	ExtensionWidgetContent,
	ExtensionWidgetOptions,
	WidgetPlacement,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
export type {
	AfterProviderResponseEvent,
	AgentEndEvent,
	AgentStartEvent,
	AutoCompactionStartEvent,
	AutoRetryEndEvent,
	AutoRetryStartEvent,
	BashToolResultEvent,
	ContextEvent,
	ContextUsage,
	CredentialDisabledEvent,
	EditToolResultEvent,
	GrepToolResultEvent,
	MessageEndEvent,
	MessageStartEvent,
	ReadToolResultEvent,
	RetryFallbackAppliedEvent,
	RetryFallbackSucceededEvent,
	SessionBeforeCompactEvent,
	ToolApprovalRequestedEvent,
	ToolApprovalResolvedEvent,
	ToolCallEvent,
	ToolExecutionEndEvent,
	ToolExecutionStartEvent,
	ToolExecutionUpdateEvent,
	ToolResultEvent,
	TurnEndEvent,
	TurnStartEvent,
	WriteToolResultEvent,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
export type { GoalUpdatedEvent } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
export type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
export type { SessionEntry } from "@oh-my-pi/pi-coding-agent/session/session-entries";
export type { ContextUsageLevel } from "@oh-my-pi/pi-tui/chrome/context-thresholds";
export type { SymbolPreset, Theme, ThemeColor } from "@oh-my-pi/pi-tui/theme/theme";
