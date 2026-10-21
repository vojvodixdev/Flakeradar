import { describe, expect, it } from 'vitest';
import { JUnitParseError, parseJUnit, parseJUnitReports } from './junit.js';

describe('parseJUnit', () => {
  it('parses a typical Jest/Vitest style report', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <testsuites name="unit" tests="3" failures="1">
        <testsuite name="cart.test.ts" file="src/cart.test.ts">
          <testcase classname="Cart" name="adds an item" time="0.012"/>
          <testcase classname="Cart" name="applies a coupon" time="0.340">
            <failure message="expected 90 to be 80">AssertionError: expected 90 to be 80
    at cart.test.ts:42</failure>
          </testcase>
          <testcase classname="Cart" name="ships abroad" time="0">
            <skipped/>
          </testcase>
        </testsuite>
      </testsuites>`;

    const cases = parseJUnit(xml);

    expect(cases).toHaveLength(3);
    expect(cases[0]).toMatchObject({
      key: 'Cart::adds an item',
      suite: 'cart.test.ts',
      file: 'src/cart.test.ts',
      status: 'passed',
      durationMs: 12,
      attempt: 1,
    });
    expect(cases[1]).toMatchObject({ status: 'failed', message: 'expected 90 to be 80', durationMs: 340 });
    expect(cases[2]).toMatchObject({ status: 'skipped', message: null });
  });

  it('accepts a bare <testsuite> root and falls back to the suite name as classname', () => {
    const xml = `<testsuite name="tests.api"><testcase name="test_login" time="1.5"><error message="Timeout"/></testcase></testsuite>`;
    const [tc] = parseJUnit(xml);
    expect(tc).toMatchObject({ key: 'tests.api::test_login', status: 'failed', message: 'Timeout' });
  });

  it('walks nested suites', () => {
    const xml = `<testsuites><testsuite name="outer"><testsuite name="inner"><testcase name="deep"/></testsuite></testsuite></testsuites>`;
    expect(parseJUnit(xml).map((c) => c.key)).toEqual(['inner::deep']);
  });

  it('expands Surefire flakyFailure into failed attempts followed by a pass', () => {
    const xml = `<testsuite name="s">
      <testcase classname="PaymentIT" name="charges card" time="2.0">
        <flakyFailure message="Connection reset"/>
        <flakyFailure message="Connection reset again"/>
      </testcase>
    </testsuite>`;
    const cases = parseJUnit(xml);
    expect(cases.map((c) => [c.status, c.attempt])).toEqual([
      ['failed', 1],
      ['failed', 2],
      ['passed', 3],
    ]);
    expect(cases[2]!.durationMs).toBe(2000);
  });

  it('expands Surefire rerunFailure into several failed attempts', () => {
    const xml = `<testsuite name="s"><testcase classname="A" name="b"><failure message="x"/><rerunFailure message="y"/></testcase></testsuite>`;
    expect(parseJUnit(xml).map((c) => c.status)).toEqual(['failed', 'failed']);
  });

  it('numbers attempts across several reports from the same run', () => {
    const first = `<testsuite name="s"><testcase classname="Login" name="works"><failure/></testcase></testsuite>`;
    const retry = `<testsuite name="s"><testcase classname="Login" name="works"/></testsuite>`;
    const cases = parseJUnitReports([first, retry]);
    expect(cases.map((c) => [c.status, c.attempt])).toEqual([
      ['failed', 1],
      ['passed', 2],
    ]);
  });

  it('decodes XML entities in names and messages', () => {
    const xml = `<testsuite name="s"><testcase classname="Q" name="a &lt; b"><failure message="&quot;x&quot; &amp; y"/></testcase></testsuite>`;
    const [tc] = parseJUnit(xml);
    expect(tc!.name).toBe('a < b');
    expect(tc!.message).toBe('"x" & y');
  });

  it('accepts an empty <testsuites/> report', () => {
    expect(parseJUnit('<testsuites/>')).toEqual([]);
  });

  it('rejects malformed XML with a helpful error', () => {
    expect(() => parseJUnit('<testsuite><testcase></testsuite>')).toThrow(JUnitParseError);
    expect(() => parseJUnit('')).toThrow(/empty/);
    expect(() => parseJUnit('<html></html>')).toThrow(/Root element/);
  });
});
