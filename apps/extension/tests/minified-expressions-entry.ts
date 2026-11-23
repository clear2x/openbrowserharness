/**
 * Print the four page-injection expressions assembled from THIS module
 * instance. The minified-snapshot spec bundles this entry with esbuild
 * --minify — the production failure mode — and evaluates the printed
 * expressions in jsdom, so a helper that leaks a module-scope (renamed)
 * identifier into a page breaks here instead of on a user's page.
 */
import type { PageElementInfo } from '@deepseek-ai/dsh-browser'
import { deepQuery } from '../src/shared/deep-query'
import {
  SNAPSHOT_EXPRESSION,
  buildResolveExpression,
  clickProbeExpression,
  elementVisible,
  pollUntilExpression,
} from '../src/background/dom-snapshot'

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
    var el = ${deepQuery.name}(document, ${JSON.stringify('#nowhere')}, ${JSON.stringify('__invalid__')});
    if (el === ${JSON.stringify('__invalid__')}) return 'invalid';
    if (el !== null && el !== undefined && ${elementVisible.name}(el)) return 'found';
    return null;
  };
})()`

console.log(JSON.stringify({
  snap: SNAPSHOT_EXPRESSION,
  resolve: buildResolveExpression(resolveRecord),
  probe: clickProbeExpression('#nowhere'),
  wait: pollUntilExpression(waitSource, 50, 200),
}))
