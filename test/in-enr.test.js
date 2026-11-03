import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contestMatcher } from '../collector/lib/contest.js';
import { parseOfficeCategory } from '../collector/adapters/in-enr.js';

test('house matcher understands spelled-out districts (Indiana) without cross-matching', () => {
  const cases = [
    ['IN-05', 'United States Representative, Fifth District', true],
    ['IN-01', 'United States Representative, First District', true],
    ['IN-05', 'United States Representative, First District', false],
    ['IN-01', 'United States Representative, Twenty-First District', false],
    ['IN-05', 'United States Representative, Fifteenth District', false],
    ['TX-21', 'U.S. Representative, Twenty First District', true],
    ['TX-20', 'United States Representative, Twentieth District', true],
    ['IN-05', 'State Representative, Fifth District', false],
    ['NC-01', 'US HOUSE OF REPRESENTATIVES DISTRICT 01', true],
    ['MI-07', 'Representative in Congress 7th District', true],
  ];
  for (const [id, name, want] of cases) assert.equal(contestMatcher('auto', id).test(name), want, `${id} vs "${name}"`);
});

test('in-enr: county rows for the matching district only', () => {
  const json = {
    Root: {
      WriteTime: '2026-11-03T19:12:00',
      OfficeCategory: {
        Regions: {
          Region: [
            {
              Races: {
                Race: [
                  {
                    OFFICE_TITLE: 'United States Representative, Fifth District',
                    Jurisdiction: { JURISDICTION_NAME: 'Hamilton' },
                    Candidates: {
                      Candidate: [
                        { NAME_ON_BALLOT: 'J.D. Ford', PARTY_ABBREV: 'D', TOTAL_VOTES: 1200 },
                        { NAME_ON_BALLOT: 'Victoria Spartz', PARTY_ABBREV: 'R', TOTAL_VOTES: '1,050' },
                      ],
                    },
                  },
                  // a single candidate arrives as an object, not an array
                  { OFFICE_TITLE: 'United States Representative, Fifth District', Jurisdiction: { JURISDICTION_NAME: 'Madison' }, Candidates: { Candidate: { NAME_ON_BALLOT: 'J.D. Ford', PARTY_ABBREV: 'D', TOTAL_VOTES: 5 } } },
                ],
              },
            },
            { Races: { Race: { OFFICE_TITLE: 'United States Representative, First District', Jurisdiction: { JURISDICTION_NAME: 'Lake' }, Candidates: { Candidate: [{ NAME_ON_BALLOT: 'Frank J. Mrvan', PARTY_ABBREV: 'D', TOTAL_VOTES: 9 }] } } } },
          ],
        },
      },
    },
  };
  const { rows, writeTime } = parseOfficeCategory(json, { contestFilters: [contestMatcher('auto', 'IN-05')] });
  assert.equal(writeTime, '2026-11-03T19:12:00');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], { county: 'Hamilton', precinct: null, level: 'county', contest: 'United States Representative, Fifth District', candidate: 'Victoria Spartz', party: 'R', mode: 'TOTAL', votes: 1050, prTot: 1, prRep: 0, prUnknown: true });
  assert.equal(rows[2].county, 'Madison');
  // once the office is marked ALLREPORTED, county totals count as final
  assert.equal(parseOfficeCategory(json, { contestFilters: [contestMatcher('auto', 'IN-05')] }, true).rows[0].prRep, 1);
});
