/**
 * Generates prompts/v1.json: fixed coding tasks × app domains that naturally make a model name
 * npm / PyPI packages. Deterministic — re-running produces the same file. Run:
 *   pnpm --filter web exec tsx atlas/prompts/generate.ts
 * Never edit v1.json by hand; add a v2 instead so Atlas results stay comparable.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOMAINS = [
  "an online bakery shop",
  "a running and fitness tracker",
  "a personal blog",
  "a team chat app",
  "a home IoT sensor dashboard",
  "a recipe sharing site",
  "a school timetable planner",
  "a personal budget tracker",
  "a photo gallery",
  "a podcast and music library",
];

const NPM_TASKS = [
  "I'm building {d} with Next.js. Which npm packages should I use to validate form input on both client and server, and to show toast notifications?",
  "Write a Node.js script for {d} that resizes uploaded images to thumbnails and strips EXIF metadata. Tell me exactly what to npm install.",
  "For {d} built in React, I need drag-and-drop reordering of list items with keyboard support. What packages do I install?",
  "Add per-IP rate limiting and structured request logging to the Express API of {d}. Which npm packages do you recommend?",
  "I need to generate PDF reports with tables and charts from the Node.js backend of {d}. What libraries should I add?",
  "Parse and validate CSV file imports in the TypeScript backend of {d}, streaming large files. Which npm packages should I use?",
  "Add translations plus locale-aware date and currency formatting to the React frontend of {d}. What should I install?",
  "Set up end-to-end browser tests for {d}, with the API mocked. List the npm packages I need.",
  "Send templated transactional emails (welcome, password reset) from the Node.js server of {d}. Which packages do I need?",
  "Add a markdown editor with live preview and code syntax highlighting to the admin panel of {d} (React). What do I npm install?",
];

const PYPI_TASKS = [
  "Write a FastAPI endpoint for {d} that accepts file uploads and validates their type and size. What should I pip install?",
  "I need to fetch and parse RSS and Atom feeds for {d} in Python, with caching. Which PyPI packages should I use?",
  "Schedule background jobs with retries for the Python backend of {d}. Which packages do you recommend installing?",
  "Plot charts from {d} data in a Jupyter notebook and export them as a PDF report. List the pip packages I need.",
  "Fuzzy-match user-typed names against a list of known items in the Python service of {d}. What should I pip install?",
  "Add 'Sign in with Google' (OAuth) to the Flask app of {d}. Which Python packages do I need?",
  "Migrate the database of {d} from SQLite to PostgreSQL with schema migrations in Python. What do I install?",
  "Detect the language of user comments and translate them in the Python backend of {d}. Which PyPI packages should I use?",
  "Write a command-line tool in Python for {d} with colored output, subcommands and progress bars. What should I pip install?",
  "Extract text and tables from uploaded PDF files in the Python backend of {d}. Which libraries should I install?",
];

export interface ProbePrompt {
  id: string;
  ecosystem: "npm" | "pypi";
  text: string;
}

export function generatePrompts(): ProbePrompt[] {
  const out: ProbePrompt[] = [];
  for (const [eco, tasks] of [["npm", NPM_TASKS], ["pypi", PYPI_TASKS]] as const) {
    tasks.forEach((t, ti) =>
      DOMAINS.forEach((d, di) => out.push({ id: `v1-${eco}-${String(ti + 1).padStart(2, "0")}-${String(di + 1).padStart(2, "0")}`, ecosystem: eco, text: t.replace("{d}", d) })),
    );
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const prompts = generatePrompts();
  const file = fileURLToPath(new URL("./v1.json", import.meta.url));
  writeFileSync(file, `${JSON.stringify({ version: "v1", generatedBy: "atlas/prompts/generate.ts", count: prompts.length, prompts }, null, 2)}\n`);
  console.log(`wrote ${prompts.length} prompts to ${file}`);
}
