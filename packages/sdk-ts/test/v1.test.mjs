import assert from "node:assert/strict";
import test from "node:test";
import { API_V1_PATHS } from "../dist/v1.js";

test("editor week and delivery claim paths encode path and query values", () => {
  assert.equal(API_V1_PATHS.editorWeek("person/1", "2026-W41"), "/v1/editors/person%2F1/week?week=2026-W41");
  assert.equal(API_V1_PATHS.claimableDeliveries("2026-W41"), "/v1/deliveries/claimable?week=2026-W41");
  assert.equal(API_V1_PATHS.deliveryClaims("2026-W41"), "/v1/deliveries/claims?week=2026-W41&status=pending");
  assert.equal(API_V1_PATHS.claimDelivery("file/one"), "/v1/deliveries/file%2Fone/claim");
  assert.equal(API_V1_PATHS.decideDeliveryClaim("file one"), "/v1/deliveries/file%20one/claim/decide");
  assert.equal(API_V1_PATHS.claimableDesigns("2026-W41"), "/v1/designs/claimable?week=2026-W41");
  assert.equal(API_V1_PATHS.designClaims("2026-W41", "confirmed"), "/v1/designs/claims?week=2026-W41&status=confirmed");
  assert.equal(API_V1_PATHS.claimDesign("file one"), "/v1/designs/file%20one/claim");
  assert.equal(API_V1_PATHS.claimableUploaderAccounts(), "/v1/accounts/claimable");
  assert.equal(API_V1_PATHS.uploaderAccountClaims("pending"), "/v1/accounts/claims?status=pending");
  assert.equal(API_V1_PATHS.claimUploaderAccount("account/one"), "/v1/accounts/account%2Fone/claim");
  assert.equal(API_V1_PATHS.decideUploaderAccountClaim("account one"), "/v1/accounts/account%20one/claim/decide");
  assert.equal(API_V1_PATHS.revertUploaderAccountClaim("account/one"), "/v1/accounts/account%2Fone/claim/revert");
});
