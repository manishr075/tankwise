# AWS hardening options (recommendations only)

Status: **proposal, nothing changed.** No infrastructure, account setting, or deployed resource has been modified. Each item needs an explicit go-ahead before it is applied, and each is a separate stack update or account change.

Costs below are qualitative. This table is about a small hackathon table with low traffic. Check current AWS pricing before enabling anything billable.

## Summary

| # | Option | Benefit | Risk to the existing deployment | Cost | Recommendation |
|---|---|---|---|---|---|
| 1 | Table retention (`DeletionPolicy: Retain`, `UpdateReplacePolicy: Retain`) | `sam delete` or a failed stack rollback can no longer delete decision history | None to data. The table stays behind after a delete and must be removed by hand later. | None, apart from the stored data | **Approve.** Lowest risk, highest protection. |
| 2 | Point-in-time recovery (PITR) on the table | Restore to any second in the last 35 days after an accidental delete, overwrite, or bad change | Turning it on is a table update with no data change | Billed on table size. For this table, expected to be very small. | **Approve.** |
| 3 | AWS Budgets alert (monthly, email) | Early warning if usage or cost spikes | None. It sends alerts only. It does not stop spend. | Budgets has a free allowance; confirm current limits | **Approve** with a notification address you choose. |
| 4 | Lambda reserved concurrency (for example 5) | Hard cap on parallel executions, which limits the cost of abuse | Requests above the cap are throttled and users see errors. Set it above the expected demo concurrency. | No charge for the setting itself | **Consider** after the demo load is known. |
| 5 | Record TTL (`ttl` attribute plus table TTL) | Old decisions expire automatically, which bounds storage and personal-data retention | **Destructive by design.** Records older than the TTL are deleted. Existing items without a `ttl` attribute are kept. | AWS documents that TTL deletes do not consume write capacity. Confirm current pricing. | **Decide the retention period first** (for example 90 or 180 days). Then approve. |
| 6 | API protection: throttle tuning | Lower rate and burst limits reduce abuse | Too-low limits can block a live demo | None | **Consider.** Lower the limits only after measuring demo traffic. |
| 7 | API protection: AWS WAF rate rule | Blocks high-volume sources | Requires CloudFront or another front door. As I understand current AWS documentation, WAF does not attach directly to HTTP APIs. Confirm before relying on this. It changes the public URL. | Web ACL and rule charges, plus CloudFront | **Defer.** Only if abuse is actually observed. |
| 8 | API protection: authentication (Cognito/JWT authorizer, or REST API with API keys) | Only known users can read or write | A JWT authorizer adds user accounts, which the brief excludes. A REST API move changes the endpoint URL and breaks the frontend contract. | Cognito and API Gateway charges | **Not recommended** for this demo. Note it as a known limitation. |

## Details

### 1. Table retention
- **What changes:** `DeletionPolicy: Retain` and `UpdateReplacePolicy: Retain` on `WaterPlanTable`. This is a template-only change applied by a stack update. It does not replace the table.
- **Why it matters:** the README recommends `sam delete`. Without a retention policy, that command deletes the table and all decision history.
- **Trade-off:** after a delete, the table remains and must be removed manually when it is no longer needed.

### 2. Point-in-time recovery
- **What changes:** `PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: true }` on the table.
- **Why it matters:** protects decision history from accidental writes or deletes, and is useful evidence of data care in a submission.
- **Trade-off:** backup storage is billed by table size, and the table is small.

### 3. Budget alert
- **What changes:** one AWS Budgets monthly budget with a notification email. This is an account-level resource, so it needs explicit approval.
- **Why it matters:** alerts are the simplest early warning. Budget actions that enforce a limit need more IAM setup and are not recommended now.

### 4. Reserved concurrency
- **What changes:** `ReservedConcurrentExecutions` on `TankwiseFunction`.
- **Why it matters:** caps the number of parallel Lambda executions, which bounds how far abuse can scale.
- **Trade-off:** the cap is hit only under heavy load, and throttled requests fail. Choose a value above the expected demo concurrency.

### 5. Record TTL
- **What changes:** a numeric `ttl` attribute (epoch seconds) on each new record, and TTL enabled on the table with the attribute name `ttl`. The API contract is unchanged, but the record shape gains one attribute.
- **Why it matters:** bounds storage growth and personal-data retention. Decision records include building names and inputs.
- **Trade-off:** data is deleted after the TTL. Existing items without the attribute are kept, so a clean-up plan is needed for them.
- **Decision needed:** the retention period.

### 6. Throttle tuning
- The current stage throttle is 10 requests per second with a burst of 20 (`DefaultRouteSettings`). Measure demo traffic before lowering it.

### 7. WAF
- Only worth it if abuse is observed. It needs a front door such as CloudFront, which changes the public URL the frontend uses. Confirm current AWS support for HTTP APIs before planning this.

### 8. Authentication
- Anyone who knows the API URL and a building name can write records and read that building's history. Building names are guessable, so history is not private. The honest fix is authentication, which is out of scope for this demo. Mitigation options if needed later: make building IDs unguessable, or add authentication.

## Other findings from the audit (not infrastructure changes)

- **CORS:** Stage 3 makes the Lambda honour `AllowedOrigin` through `ALLOWED_ORIGIN`. Confirm after the next deploy that API Gateway does not add a second `Access-Control-Allow-Origin` header.
- **Lambda artifact:** `CodeUri: backend/` also packages `tests/` and the dev requirements file. Harmless, but a `.samignore` or a build step would tidy it.
- **Cost guard in the README:** the cleanup command (`sam delete`) will delete data unless option 1 is approved.

## Proposed order of approval

1. Options 1 and 2 (retention and PITR) in one stack update.
2. Option 3 (budget alert).
3. Option 4 after measuring demo traffic.
4. Option 5 once you choose a retention period.
5. Options 6 to 8 only if the situation changes.
