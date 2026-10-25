# Reisplanner P+Trein

Webapp: met de auto naar een station met gratis parkeren (met geschatte parkeerkans), daarna met de trein (bus/tram/metro alleen als de trein geen optie is), met vouwfiets of OV-fiets. Toont direct de laatste en de laatste snelle terugreis en slaat terugreizen met meer dan een uur wachttijd over.

Live (na publicatie): https://brennyc86.github.io/reisplanner/

- Dienstregeling/realtime: [Transitous](https://transitous.org) (MOTIS), rijtijden: OSRM. Alles draait in de browser, geen server.
- `stations.json`: gratis-parkeerstations met geschatte capaciteit en tijd waarop het terrein doordeweeks meestal vol is. Dit zijn schattingen, in de app aan te passen.
- `plan.js`: planlogica (zonder DOM), `app.js`: interface.
