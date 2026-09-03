# Anthem CA — document upload slots

**Out of PoC scope** (the boundary is the end of the employer application), but
documented because it is the next stage and because it explains several payload
fields.

The portal has eight slots. Each file is chosen individually with **Choose File**,
then **Upload Documents** attaches them all. Confirmation reads *"Thanks, all
required documents have been uploaded"*. Then **Uploads Complete** finalises the
submission — screenshot the page that loads.

| Portal field | Document | Source |
|---|---|---|
| Online Census Enrollment Tool | OCE Census | Produced in the employee-enrollment stage |
| Employer Application | ER App | Already attached from the application stage |
| Electronic Debit Form | EFT Form | Hippo, completed with banking from Panda |
| Agent Quote | Quote | Already attached from the quote stage |
| Waivers | Combined employee waivers | Hippo — zip or combined PDF. **Required for all employees**, even those already on the OCE census |
| Legal Docs | SOI | Gdrive. Other legal docs combined into one file |
| Proof of Waivers | Waiver ID cards | Gdrive, if provided |

## Why this matters to the payload

`payload.s3Link` points at the group's submission folder, which is where these
documents live. A missing required document is a **BusinessException** — the
runbook's instruction is to *ticket the OA*, i.e. a human has to produce it.

## Missed a document after submitting?

If the group was submitted a day or more ago, **wait for the carrier to send the
pending item** rather than uploading late and causing confusion. Otherwise:
re-enter the portal, Related tab → Applications → *Attachments and Notes* →
upload → **Uploads Complete**.
