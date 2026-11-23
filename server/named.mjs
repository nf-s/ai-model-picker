// The practitioners' named records, served only to signed-in, granted
// accounts. `named-private.json` from the records build is split in two:
// people, review notes, coverage (with the records that need reading) and use
// records, which every Named band needs, and method advice, which only person
// pages show.

/** The two parts of `named-private.json` the endpoints serve. */
export function namedParts(named) {
  const { version, review, people, coverage, pending, use, advice } = named;
  return {
    named: { version, review, people, coverage, pending, use },
    advice: { version, advice },
  };
}
