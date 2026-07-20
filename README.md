# DienstenLezer

DienstenLezer leest diensten-pdf's uit, visualiseert omlopen en diensten en koppelt de planning aan actuele Qbuzz-gegevens. Dezelfde codebase werkt als lokale ontwikkelapp, als website met backend en als Windows-app.

## Lokale ontwikkeling

Dubbelklik op `start-app.bat`, of voer uit:

```powershell
npm run dev
```

Dit start de React-ontwikkelserver en de Rust-backend samen. Open daarna `http://127.0.0.1:5173/`. Vite stuurt `/api` tijdens ontwikkeling automatisch door naar `http://127.0.0.1:8080`.

Los starten kan ook:

```powershell
npm run web:dev
npm run server:dev
```

De lokale serverdata komt in `server-data/` te staan.

## Server op deze computer

Dubbelklik op `start-server.bat` om de gebouwde website en backend op poort 8080 te starten. De server luistert ook op het thuisnetwerk, zodat je Cloudflare Tunnel op Home Assistant hem kan bereiken via het lokale IP-adres van deze computer. Sluit het zwarte venster of gebruik `stop-server.bat` om de server weer uit te zetten.

## Home Assistant OS

Dezelfde webinterface en Rust-backend kunnen als Home Assistant-app op een Raspberry Pi 4 (`aarch64`) draaien. Maak een lokaal proefpakket met:

```powershell
npm run ha:addon:package
npm run ha:addon:check
```

Het uitgepakte pakket staat daarna in `artifacts/home-assistant/` en als archief in `artifacts/dienstenlezer-home-assistant.tar.gz`. Pdf's, opgeslagen planningen en de Qbuzz-cache komen niet in het image terecht; de app bewaart die blijvend in Home Assistant-map `/data`.

De volledige proef-, migratie- en terugvalvolgorde staat in `deploy/home-assistant/MIGRATION.md`. De gewone Windows-ontwikkeling, webserver en exe-build blijven daarnaast beschikbaar.

## Website op een domein

Een domeinnaam alleen kan geen backend uitvoeren. Je hebt daarnaast een VPS, thuisserver of hostingdienst nodig die Docker-containers of een eigen programma kan draaien.

1. Laat het A- of AAAA-record van je domein naar de server wijzen.
2. Zet deze projectmap op de server.
3. Start de app:

```bash
docker compose up -d --build
```

4. Zet een HTTPS-reverse-proxy voor poort 8080. In `deploy/Caddyfile.example` staat een Caddy-configuratie met wachtwoordbeveiliging.

De container bewaart de pdf-bank en Qbuzz-cache in het Docker-volume `dienstenlezer-data`. Maak van dit volume regelmatig een back-up. De eerste live-aanvraag kan langer duren doordat de GTFS-dienstregeling eenmalig wordt gedownload en geindexeerd.

De webversie bewaart geuploade pdf's blijvend op de server en deelt ze tussen alle browsers die hetzelfde domein gebruiken. Gewone bezoekers downloaden de originele pdf's niet: de app haalt alleen het actieve dagsegment als gecomprimeerde planning op. Die planning wordt op het apparaat gecachet en alleen opnieuw opgehaald wanneer de bestandenbank verandert. Bescherm het domein daarom met een wachtwoord; zonder beveiliging kan iedere bezoeker bestanden toevoegen, uitschakelen of verwijderen.

De pdf-parser wordt pas geladen wanneer iemand daadwerkelijk bestanden uploadt. Live-aanvragen vanuit de webversie sturen alleen de datum naar de server; de server selecteert zelf de relevante ritten uit de opgeslagen planning.

Controleer de backend na plaatsing via:

```text
https://jouwdomein.nl/api/health
```

Dit hoort `{"status":"ok","service":"dienstenlezer"}` terug te geven.

## Productiebuild zonder Docker

```powershell
npm run web:build
npm run server:build
```

Start daarna `src-tauri/target/release/dienstenlezer-server` vanuit de projectmap. Instellingen:

- `DIENSTENLEZER_BIND`: luisteradres, standaard `127.0.0.1:8080`.
- `DIENSTENLEZER_DATA_DIR`: blijvende datamap, standaard `server-data`.
- `DIENSTENLEZER_WEB_DIR`: map met de webbuild, standaard `dist`.

## Windows-app

De exe blijft beschikbaar. Ontwikkelen:

```powershell
npm run desktop:dev
```

Een installer maken:

```powershell
npm run desktop:build
```

De Windows-app gebruikt dezelfde livekern, maar houdt zijn pdf-bank lokaal op de computer. De domeinversie en de exe delen dus niet automatisch dezelfde geuploade bestanden.

## Controles

```powershell
npm test
npm run web:build
npm run server:build
```
