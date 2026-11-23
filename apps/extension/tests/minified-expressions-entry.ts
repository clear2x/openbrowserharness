/**
 * Print every page-injection expression assembled from THIS module
 * instance. The minified-snapshot spec bundles this entry with esbuild
 * --minify — the production failure mode — and statically walks the
 * printed expressions, so a helper that leaks a module-scope (renamed)
 * identifier into a page breaks here instead of on a user's page.
 *
 * Every builder here lives in a dependency-free module (plain Node can
 * load the bundle): the snapshot walk, the element re-resolve, the click
 * probe, the wait poll's check source, the snapshot pre-step sweep, the
 * typed-value readback, and the page_find_related collector.
 */
import type { PageElementInfo } from '@deepseek-ai/dsh-browser'
import { INVALID_SELECTOR, deepQuery } from '../src/shared/deep-query'
import {
  SNAPSHOT_EXPRESSION,
  buildPrepExpression,
  buildResolveExpression,
  clickProbeExpression,
  elementVisible,
  pollUntilExpression,
} from '../src/background/dom-snapshot'
import { clearValueScript, inputValueFallbackScript } from '../src/background/structured-value'
import { COLLECT_EXPRESSION } from '../src/offscreen/page-find-collector'
import { targetProbeExpression } from '../src/offscreen/page-batch-page'

const resolveRecord: PageElementInfo = {
  index: 3,
  tag: 'button',
  selector: '#nowhere',
  text: 'x',
  rect: { x: 1, y: 1, width: 2, height: 2 },
  center: { x: 2, y: 2 },
  interactive: true,
}

// The wait check replicates waitFor's checkSource shape: deepQuery +
// elementVisible interpolated by their runtime names (the leak surface).
const waitSource = `(function () {
  var ${deepQuery.name} = ${deepQuery.toString()};
  var ${elementVisible.name} = ${elementVisible.toString()};
  return function () {
    var el = ${deepQuery.name}(document, ${JSON.stringify('#nowhere')}, ${JSON.stringify(INVALID_SELECTOR)});
    if (el === ${JSON.stringify(INVALID_SELECTOR)}) return 'invalid';
    if (el !== null && el !== undefined && ${elementVisible.name}(el)) return 'found';
    return null;
  };
})()`

console.log(JSON.stringify({
  snap: SNAPSHOT_EXPRESSION,
  resolve: buildResolveExpression(resolveRecord),
  probe: clickProbeExpression('#nowhere'),
  wait: pollUntilExpression(waitSource, 50, 200),
  prep: buildPrepExpression({ freeze: true, banner: true, lazy: true, checkToken: null, setToken: 'tok-1' }),
  readback: inputValueFallbackScript('#field', 'typed', deepQuery, INVALID_SELECTOR),
  clear: clearValueScript('#field', deepQuery, INVALID_SELECTOR, true),
  find: COLLECT_EXPRESSION,
  batchTarget: targetProbeExpression('#nowhere', true),
}))
