# DIAGNOSE — live-weergave verdwenen (~31 mei)

Dit document legt de bevindingen van **Fase 1** vast. De diagnose-logging zit achter een
DEBUG-flag, zodat ze nooit in een normale demo-log meelekt.

## Hoe de diagnose-logging aanzetten

1. Netlify → Site settings → Environment variables → voeg toe: `DEBUG_DIAGNOSE = 1`
2. Redeploy (of trigger een nieuwe functie-cold-start).
3. Open de Netlify-functielogs (`netlify functions:log` of het dashboard) en kijk **live** mee.
4. Doe één echt telefoongesprek met Lisa.
5. Zet `DEBUG_DIAGNOSE` daarna weer op `0` of verwijder de variabele.

## Wat je in de logs ziet

- **`webhook.js`** → per binnenkomend event:
  `[diag webhook] type= <event-type> keys= <komma-gescheiden top-level velden>`
  Hiermee zie je welke event-types Vapi nu stuurt bij call-start (bv. `assistant.started`
  in punt-notatie i.p.v. kebab-case) en welke velden meekomen.
- **`calls.js`** → per dashboard-poll (elke 2s):
  - `[diag calls] VAPI CALLS:` — array met `{id, status, endedAt}` van élke call die de
    Vapi REST `/call`-lijst teruggeeft.
  - `[diag calls] SAMPLE:` — eerste 3000 tekens van het eerste call-object (volledige vorm).

## In te vullen na een echt gesprek

### (a) Verschijnt het lopende gesprek tijdens de call in de REST-lijst?

> _TODO — vul in op basis van `[diag calls] VAPI CALLS`._
>
> - Verschijnt het call-id tijdens het gesprek in de lijst? **ja / nee**
> - Zo ja, met welke `status`-waarde? (bv. `in-progress`, `ringing`, `queued`, `forwarding`, …)
> - Heeft het tijdens het gesprek al een `endedAt`? **ja / nee**

### (b) Welke event-types stuurt Vapi nu bij call-start?

> _TODO — vul in op basis van `[diag webhook] type=`._
>
> - Eerste events bij start (in volgorde): …
> - Komt `assistant.started` (punt-notatie) voor? **ja / nee**
> - Komt nog `call.started` / `call-start` / `assistant-request` voor? **ja / nee**

## Twee mogelijke faalmodi (beide afgedekt door de Fase 2-fix)

1. **REST-timing** — het lopende gesprek staat (nog) niet in de Vapi REST `/call`-lijst tijdens
   de call → niets om live te tonen, ook al staat de data al in Redis.
2. **Status-mismatch** — Vapi geeft het gesprek wél terug, maar met een andere `status` dan
   `'in-progress'` → de oude check `call.status === 'in-progress'` werd `false`.

Daarnaast zette de webhook `meta.status = 'active'` alleen bij `call.started` / `call-start` /
`assistant-request`; de nieuwe `assistant.started` viel in `default`, dus die markering werd
nooit gezet.

## Conclusie

> _TODO — noteer welke faalmodus (1, 2 of beide) is bevestigd, en of `assistant.started`
> daadwerkelijk de nieuwe start-marker is._

De Fase 2-fix maakt de live-weergave robuust voor **beide** faalmodi: het dashboard voedt
actieve gesprekken rechtstreeks uit Redis (los van REST-timing) en bepaalt "actief" niet meer
op de letterlijke string `'in-progress'` maar op `!endedAt && status ∉ {ended, failed, …}`.
