import { XMLParser, XMLValidator } from 'fast-xml-parser';
import type { ExecutionStatus, ParsedTestCase } from './types.js';

export class JUnitParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JUnitParseError';
  }
}

const MAX_MESSAGE_LENGTH = 2000;

// Elements that can legitimately appear more than once must always be parsed
// as arrays, otherwise a report with a single test looks different from one
// with many.
const ARRAY_TAGS = new Set([
  'testsuite',
  'testcase',
  'failure',
  'error',
  'skipped',
  'flakyFailure',
  'flakyError',
  'rerunFailure',
  'rerunError',
]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  textNodeName: '#text',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  // fast-xml-parser never resolves external entities, so reports cannot be
  // used for XXE attacks. Built-in entities (&lt; etc.) are still decoded.
  processEntities: true,
  isArray: (tagName) => ARRAY_TAGS.has(tagName),
});

type XmlNode = Record<string, unknown>;

interface RawCase {
  suite: string;
  classname: string;
  name: string;
  file: string | null;
  durationMs: number;
  /** One entry per attempt, in the order they happened. */
  attempts: Array<{ status: ExecutionStatus; message: string | null }>;
}

/**
 * Parses one or more JUnit XML reports from the same CI run.
 *
 * Attempts are numbered across all reports, so a test that appears twice
 * (because the runner retried it, or because two shards both ran it) gets
 * attempt 1 and attempt 2.
 */
export function parseJUnitReports(xmlReports: string[]): ParsedTestCase[] {
  const attemptsByKey = new Map<string, number>();
  const result: ParsedTestCase[] = [];

  for (const xml of xmlReports) {
    for (const raw of extractCases(xml)) {
      const key = testKey(raw.classname, raw.name);
      for (const attempt of raw.attempts) {
        const attemptNo = (attemptsByKey.get(key) ?? 0) + 1;
        attemptsByKey.set(key, attemptNo);
        result.push({
          key,
          suite: raw.suite,
          classname: raw.classname,
          name: raw.name,
          file: raw.file,
          status: attempt.status,
          // Runners only report one duration per testcase element; attribute
          // it to the final attempt and treat earlier ones as instant.
          durationMs: attempt === raw.attempts[raw.attempts.length - 1] ? raw.durationMs : 0,
          message: attempt.message,
          attempt: attemptNo,
        });
      }
    }
  }

  return result;
}

export function parseJUnit(xml: string): ParsedTestCase[] {
  return parseJUnitReports([xml]);
}

/** The identity of a test across runs. Kept deliberately simple and readable. */
export function testKey(classname: string, name: string): string {
  return `${classname}::${name}`;
}

function extractCases(xml: string): RawCase[] {
  if (typeof xml !== 'string' || xml.trim() === '') {
    throw new JUnitParseError('Report is empty');
  }
  const validation = XMLValidator.validate(xml);
  if (validation !== true) {
    const { msg, line } = validation.err;
    throw new JUnitParseError(`Invalid XML at line ${line}: ${msg}`);
  }

  const doc = parser.parse(xml) as XmlNode;
  const cases: RawCase[] = [];

  if (doc.testsuites !== undefined) {
    // An empty <testsuites/> is valid and simply contains no tests.
    if (isNode(doc.testsuites)) {
      walkSuites(asArray(doc.testsuites.testsuite), '', null, cases);
      // Some generators put testcases directly under <testsuites>.
      collectCases(doc.testsuites, '', null, cases);
    }
  } else if (doc.testsuite !== undefined) {
    walkSuites(asArray(doc.testsuite), '', null, cases);
  } else {
    throw new JUnitParseError('Root element must be <testsuites> or <testsuite>');
  }

  return cases;
}

function walkSuites(suites: unknown[], parentName: string, parentFile: string | null, out: RawCase[]): void {
  for (const suite of suites) {
    if (!isNode(suite)) continue;
    const ownName = str(suite.name);
    const name = ownName || parentName;
    const file = str(suite.file) || parentFile;
    collectCases(suite, name, file, out);
    // JUnit allows nested suites (e.g. describe blocks in some reporters).
    walkSuites(asArray(suite.testsuite), name, file, out);
  }
}

function collectCases(container: XmlNode, suiteName: string, suiteFile: string | null, out: RawCase[]): void {
  for (const tc of asArray(container.testcase)) {
    if (!isNode(tc)) continue;
    const name = str(tc.name);
    if (!name) continue;
    const classname = str(tc.classname) || suiteName || '(root)';
    out.push({
      suite: suiteName || classname,
      classname,
      name,
      file: str(tc.file) || suiteFile,
      durationMs: secondsToMs(tc.time),
      attempts: attemptsFor(tc),
    });
  }
}

/**
 * Turns a <testcase> into the list of attempts it represents.
 *
 * Maven Surefire (and tools that copy its format) record retries inside a
 * single testcase:
 *   - <flakyFailure>/<flakyError>: the test failed, then passed on a rerun
 *   - <rerunFailure>/<rerunError>: the test failed again on a rerun
 */
function attemptsFor(tc: XmlNode): RawCase['attempts'] {
  const failures = [...asArray(tc.failure), ...asArray(tc.error)];
  const flaky = [...asArray(tc.flakyFailure), ...asArray(tc.flakyError)];
  const reruns = [...asArray(tc.rerunFailure), ...asArray(tc.rerunError)];

  if (failures.length > 0) {
    return [failures[0], ...reruns].map((el) => ({ status: 'failed' as const, message: messageOf(el) }));
  }
  if (tc.skipped !== undefined) {
    return [{ status: 'skipped', message: null }];
  }
  return [
    ...flaky.map((el) => ({ status: 'failed' as const, message: messageOf(el) })),
    { status: 'passed' as const, message: null },
  ];
}

function messageOf(el: unknown): string | null {
  let text = '';
  if (typeof el === 'string') {
    text = el;
  } else if (isNode(el)) {
    text = str(el.message) || str(el['#text']) || str(el.type);
  }
  text = text.trim();
  if (!text) return null;
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text;
}

function secondsToMs(value: unknown): number {
  const seconds = Number.parseFloat(str(value).replace(',', ''));
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function isNode(value: unknown): value is XmlNode {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}
