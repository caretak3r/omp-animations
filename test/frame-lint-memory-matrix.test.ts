import { describe, expect, test } from "bun:test";
import { type FrameLintMetadata, lintFrame } from "../scripts/frame-lint";

type Fixture = Readonly<{
	text?: string;
	metadata?: Readonly<FrameLintMetadata>;
}>;

type FixturePair = Readonly<{
	name: string;
	rule: string;
	broken: Fixture;
	corrected: Fixture;
}>;

const requiredRows = [
	"○  context  —",
	"○  cache    —",
	"○  audit    —",
	"○  limits   —",
	"○  tools    —",
	"○  files    —",
];

const box = (bodies: readonly string[]): string => {
	const width = Math.max(...bodies.map(body => Bun.stringWidth(body)));
	const border = "─".repeat(width + 2);
	const rows = bodies.map(body => `│ ${body}${" ".repeat(width - Bun.stringWidth(body))} │`);
	return [`╭${border}╮`, ...rows, `╰${border}╯`].join("\n");
};

const rulesFor = ({ text = box(requiredRows), metadata = {} }: Fixture): string[] =>
	lintFrame("frame", text, metadata).map(violation => violation.rule);

// Assemble an inert synthetic location at runtime so the fixture carries no user path.
const absoluteLocation = ["", "Users", "account", "artifact"].join("/");
const shortenedLocation = "~/artifact";

const PAIRS: readonly FixturePair[] = [
	{
		name: "post-TTL motion",
		rule: "motion-after-ttl",
		broken: { metadata: { semanticStage: "expired", motionFrameCount: 1 } },
		corrected: { metadata: { semanticStage: "expired", motionFrameCount: 0 } },
	},
	{
		name: "unproven connector",
		rule: "unproven-directional-connector",
		broken: { metadata: { directionalConnectorCount: 2, explicitRelationCount: 1 } },
		corrected: { metadata: { directionalConnectorCount: 2, explicitRelationCount: 2 } },
	},
	{
		name: "delta mislabeled write",
		rule: "observed-delta-labeled-write",
		broken: { metadata: { observedDeltaCount: 1, writeLabelCount: 1 } },
		corrected: { metadata: { observedDeltaCount: 1, writeLabelCount: 0 } },
	},
	{
		name: "stale observation erased",
		rule: "stale-observation-erased",
		broken: { metadata: { staleObservationCount: 2, retainedObservationCount: 1 } },
		corrected: { metadata: { staleObservationCount: 2, retainedObservationCount: 2 } },
	},
	{
		name: "color-only lifecycle",
		rule: "color-only-lifecycle",
		broken: { metadata: { lifecycleStateCount: 2, textualLifecycleMarkerCount: 1 } },
		corrected: { metadata: { lifecycleStateCount: 2, textualLifecycleMarkerCount: 2 } },
	},
	{
		name: "pending and completed collapse",
		rule: "pending-completed-collapse",
		broken: { metadata: { pendingCount: 1, completedCount: 1, distinctLifecycleProjectionCount: 1 } },
		corrected: { metadata: { pendingCount: 1, completedCount: 1, distinctLifecycleProjectionCount: 2 } },
	},
	{
		name: "private content",
		rule: "private-content",
		broken: { metadata: { privateContentFieldCount: 1 } },
		corrected: { metadata: { privateContentFieldCount: 0 } },
	},
	{
		name: "absolute path",
		rule: "absolute-path",
		broken: { text: box([...requiredRows, `●  memory  ${absoluteLocation}`]) },
		corrected: { text: box([...requiredRows, `●  memory  ${shortenedLocation}`]) },
	},
	{
		name: "duplicate projection",
		rule: "duplicate-source-projection",
		broken: { metadata: { sourceProjectionCount: 2 } },
		corrected: { metadata: { sourceProjectionCount: 1 } },
	},
	{
		name: "unsupported placeholder",
		rule: "unsupported-placeholder",
		broken: { metadata: { capability: "unsupported", placeholderRowCount: 1 } },
		corrected: { metadata: { capability: "unsupported", placeholderRowCount: 0 } },
	},
	{
		name: "idle row leak",
		rule: "idle-row-leak",
		broken: { metadata: { idleOptionalRowCount: 1 } },
		corrected: { metadata: { idleOptionalRowCount: 0 } },
	},
	{
		name: "retry or cancellation inference",
		rule: "retry-cancel-inference",
		broken: { metadata: { inferredRetryCount: 1, inferredCancellationCount: 1 } },
		corrected: { metadata: { inferredRetryCount: 0, inferredCancellationCount: 0 } },
	},
	{
		name: "width overflow",
		rule: "width-overflow",
		broken: { metadata: { contentWidth: 46, availableWidth: 45 } },
		corrected: { metadata: { contentWidth: 45, availableWidth: 45 } },
	},
	{
		name: "required-row displacement",
		rule: "required-row-displacement",
		broken: {
			text: box(requiredRows.slice(0, -1)),
			metadata: { requiredRowCount: 6, renderedRequiredRowCount: 5 },
		},
		corrected: { metadata: { requiredRowCount: 6, renderedRequiredRowCount: 6 } },
	},
];

const CORRECTED_MATRIX: Readonly<FrameLintMetadata> = {
	semanticStage: "expired",
	motionFrameCount: 0,
	directionalConnectorCount: 2,
	explicitRelationCount: 2,
	observedDeltaCount: 1,
	writeLabelCount: 0,
	staleObservationCount: 2,
	retainedObservationCount: 2,
	lifecycleStateCount: 2,
	textualLifecycleMarkerCount: 2,
	pendingCount: 1,
	completedCount: 1,
	distinctLifecycleProjectionCount: 2,
	privateContentFieldCount: 0,
	sourceProjectionCount: 1,
	capability: "unsupported",
	placeholderRowCount: 0,
	idleOptionalRowCount: 0,
	inferredRetryCount: 0,
	inferredCancellationCount: 0,
	contentWidth: 45,
	availableWidth: 45,
	requiredRowCount: 6,
	renderedRequiredRowCount: 6,
};

describe("frame lint temporal metadata matrix", () => {
	for (const pair of PAIRS) {
		test(`${pair.name}: the broken fixture fires only its rule`, () => {
			expect(rulesFor(pair.broken)).toEqual([pair.rule]);
		});

		test(`${pair.name}: the corrected fixture is clean`, () => {
			expect(rulesFor(pair.corrected)).toEqual([]);
		});
	}

	test("the combined corrected matrix is clean", () => {
		expect(
			rulesFor({ text: box([...requiredRows, `●  memory  ${shortenedLocation}`]), metadata: CORRECTED_MATRIX }),
		).toEqual([]);
	});

	test("unknown capability is distinct from unsupported capability", () => {
		expect(rulesFor({ metadata: { capability: "unknown", placeholderRowCount: 1 } })).toEqual([]);
		expect(rulesFor({ metadata: { capability: "unsupported", placeholderRowCount: 1 } })).toEqual([
			"unsupported-placeholder",
		]);
	});
});
