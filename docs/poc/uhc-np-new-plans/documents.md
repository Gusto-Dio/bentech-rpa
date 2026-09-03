# UHC — required documents

**Out of PoC scope** (the boundary is the end of the employer application), but
documented because it is the next stage.

## Naming rule

The portal accepts **underscores only**. No other special characters are treated
as valid, so files usually have to be renamed before upload. Worth automating
when this stage is built: a `sanitizeDocumentName()` helper, not ad-hoc renaming.

## The flow

1. **Required Documents** section
2. Upload the required tax documents
3. Screenshot the *Uploaded Documents* page → Gdrive
4. Confirm the OA-annotated QWR / payroll summary matches the annotations listed
   under *Documents Required*

## Then Finalize

Once every section shows a green check: **Finalize** → **Submit**.

A thank-you screen shows a **Member Group ID** — copy it to the Group Number in
Hippo. If policy numbers generated, screenshot and copy them too; if not, use the
4-digit plan code as the policy number.

Confirm the application moved to **Pending Acceptance**, and screenshot it.

## Gdrive uploads that close out the submission

- Copy of the quote
- Proof of finalized enrollments (employee and dependent names, policies)
- Copy of the group application
- Screenshot of the portal document attachments
- Screenshot of the Member Group ID page and any policy numbers
- Screenshot of finalization
- Hippo census, Group 3 checklist

## Why this matters to the payload

`payload.s3Link` points at the group's submission folder. A missing required
document is a **BusinessException** — a human has to produce it.
