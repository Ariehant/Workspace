// Unit tests expect United States formats (dates, times, numbers), whatever the machine's
// locale. Tests of other regions pass their region explicitly.
import { resolveRegion, setRegion } from './packages/core/src/region';

setRegion(resolveRegion({ region: 'US' }, 'en-US'));
