# Tankwise demo script (target 2:30, hard stop before 3:00)

**Before recording**
- Deploy the stack (README) and set `VITE_API_BASE_URL`. The header must say **AWS + DynamoDB connected · ap-south-1**. If it does not, do not record the AWS section as working; say it plainly.
- Do one test save so history is not empty. Close unrelated windows. Never show credentials, the AWS console login, or `.env` files.

**0:00–0:15 · Problem**
"A hostel caretaker has to decide when to book the next water tanker. Stock, daily use, supplier lead time and possible rain are all separate numbers. Tankwise turns them into one booking day you can check."

**0:15–0:40 · The decision**
Point at the big headline ("Book the next tanker by …") and the four cards: water in tank now, latest booking day with forecast rain, the no-rain date, and the estimated top-up. Point at the small line "Calculated by AWS Lambda (ap-south-1)".

**0:40–1:05 · Live weather**
In *Rain forecast location*, click **Load live 14-day rainfall**. Show the source chip change from "Example rainfall (not live)" to "Open-Meteo live forecast · fetched hh:mm" and the headline update.

**1:05–1:35 · Differentiator: no-rain stress test**
Switch the timeline between **With forecast rain** and **No-rain stress test**. Show the "Last day to book" and "Tanker arrives" markers and the dashed safety-stock line. "Rain buys N days, but if it doesn't come, this is the date that matters. Collected rain isn't assumed drinkable."

**1:35–1:55 · Change an input**
Change *Water in tank now* (e.g. 8000 → 5000). Show the yellow "Inputs changed" note and that Save is disabled until you press **Recalculate water plan**. Then recalculate and show the headline change.

**1:55–2:20 · AWS path (real)**
Click **Save this decision**. Show the message "Saved to Amazon DynamoDB … record xxxxxxxx. Lambda recalculated the result before saving", the "Last API call POST /records → 201 in … ms · execute-api.ap-south-1" line, and the new top row under **Saved decisions · Amazon DynamoDB**. Optional (5 s): show the same item in the DynamoDB console *Explore items* view without exposing account details.

**2:20–2:30 · Trust + close**
Scroll to *How this recommendation is calculated*: "Rain × roof area × efficiency, use before rain, capped at the tank. No black box." Close: "Tankwise gives a caretaker a booking date, a no-rain backup date, and a record of every decision. Next step: compare these logs with real deliveries and tank readings."

Do not use a long title card, a coding montage, or any metric that was not measured.
