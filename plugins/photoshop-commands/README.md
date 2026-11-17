# Optional Photoshop category bridge

Host-supported named notification categories only. Event descriptors, keys, shortcuts, text, clipboard and document paths are never inspected. The desktop source exposes a local bridge token and current capture epoch; pause/offline/epoch changes discard pending counts. This is not a native browser messaging host.

The source manifest requires Photoshop 25+. This is a source prerequisite, not certified coverage of every later version. An exact supported host build must be verified and recorded in the physical pilot manifest before enabling command collection. No complete editor support or edit score is claimed. Unverified structural parsing is disabled separately.

Run `node --test plugins/photoshop-commands/counter.test.cjs`. These fixtures verify category gates and descriptor exclusion, not a real Photoshop installation.
