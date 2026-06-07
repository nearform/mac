const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

const ART = [
  " ███╗   ███╗ █████╗  ██████╗ ",
  " ████╗ ████║██╔══██╗██╔════╝ ",
  " ██╔████╔██║███████║██║      ",
  " ██║╚██╔╝██║██╔══██║██║      ",
  " ██║ ╚═╝ ██║██║  ██║╚██████╗ ",
  " ╚═╝     ╚═╝╚═╝  ╚═╝ ╚═════╝ ",
].join("\n");

export function printBanner({ clearScreen = true, subtitle = "starting..." }: { clearScreen?: boolean; subtitle?: string } = {}): void {
  if (clearScreen) process.stdout.write("\x1b[2J\x1b[H"); // clear screen + reset cursor
  process.stdout.write(`${CYAN}${ART}${RESET}\n`);
  process.stdout.write(`${DIM} Mastra Agentic Coding${RESET}\n\n`);
  if (subtitle) process.stdout.write(`${DIM} ${subtitle}${RESET}\n\n`);
}

export interface ReadyOptions {
  apiPort: number;
  studioPort?: number;
}

export function printReady({ apiPort, studioPort }: ReadyOptions): void {
  const rows: Array<{ label: string; plain: string; colored: string }> = [
    {
      label: "API",
      plain: `http://localhost:${apiPort}`,
      colored: `${BOLD}http://localhost:${apiPort}${RESET}`,
    },
    ...(studioPort
      ? [
          {
            label: "Studio",
            plain: `http://localhost:${studioPort}`,
            colored: `${BOLD}http://localhost:${studioPort}${RESET}`,
          },
        ]
      : []),
  ];

  const labelWidth = Math.max(...rows.map((r) => r.label.length));

  const lines = rows.map(({ label, plain, colored }) => {
    const pad = " ".repeat(labelWidth - label.length);
    return {
      plain: `  ${label}${pad} →  ${plain}`,
      colored: `  ${label}${pad} →  ${colored}`,
    };
  });

  const maxPlain = Math.max(...lines.map((l) => l.plain.length));
  const boxWidth = maxPlain + 2;

  process.stdout.write("\n┌" + "─".repeat(boxWidth) + "┐\n");
  for (const { plain, colored } of lines) {
    const padding = " ".repeat(boxWidth - plain.length);
    process.stdout.write(`│${colored}${padding}│\n`);
  }
  process.stdout.write("└" + "─".repeat(boxWidth) + "┘\n\n");
}
