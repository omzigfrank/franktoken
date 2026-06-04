// Provider contract (documentation only — JS has no interfaces).
//
// A provider is a plain object:
//   {
//     id:    'codex',                  // stable unique id
//     name:  'OpenAI Codex',           // display name
//     color: '#10a37f',                // accent color for the UI
//     detect(): boolean,               // is this provider present on this machine?
//     async fetch(): Snapshot          // gather a usage snapshot
//   }
//
// Snapshot:
//   {
//     id, name, color,
//     available: boolean,
//     error: string | null,
//     windows: Window[],               // rate-limit windows (5h / weekly / etc.)
//     tokens: { input, cachedInput, output, reasoning, total },
//     cost:   { today, total, currency, estimated: boolean },
//     series: {                        // for charts
//       tokensByDay: [{ date, total }],
//       costByDay:   [{ date, cost }]
//     },
//     meta: { lastActivity: ms|null, sessions: number, model: string|null }
//   }
//
// Window:
//   {
//     id, label,                       // e.g. '5h', 'Weekly'
//     usedPercent: number,             // 0..100
//     windowMinutes: number | null,
//     resetsAt: ms | null,             // epoch millis
//     estimated: boolean               // true when not reported by the provider
//   }
//
// To add a provider: drop a new file in this folder that default-exports the
// object above and add it to the list in registry.js.
export const SnapshotShape = true
