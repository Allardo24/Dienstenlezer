# DienstenLezer

DienstenLezer bewaart de pdf-bank, uitgepakte dienstregeling en Qbuzz-cache in de blijvende add-onmap `/data`. Home Assistant neemt deze map mee in een volledige back-up.

## Starten

1. Start de app.
2. Open de webinterface via **Open webinterface**.
3. Controleer dat de bestaande overzichten laden.
4. Upload pas daarna eventueel diensten-pdf's.

De eerste live-aanvraag kan langer duren doordat de GTFS-dienstregeling wordt gedownload en geindexeerd. Latere starts gebruiken de lokale cache.

## Netwerk

De webinterface gebruikt standaard poort `8080`. Een bestaande Cloudflare Tunnel kan na de proefmigratie naar het lokale IP-adres van Home Assistant en deze poort worden omgezet.

## Data

Persoonlijke dienstbladen worden in de browser uitgelezen. Alleen de dienstkop en ritregels worden per account opgeslagen in `/data/dienstenlezer.sqlite3`, in `personal_schedules`; de PDF en chauffeursnaam worden niet opgeslagen. Lokaal staat deze database standaard in `server-data/dienstenlezer.sqlite3`.

Een persoonlijke dienst kan alleen bij zijn uitvoeringsdatum worden geladen. Uploaden telt nog niet als rijden: na bevestiging staat een zelfstandige registratie in `duty_records` en `duty_segments`. Verwijderen van de upload verandert die statistieken niet. Maak een back-up van de accountdatabase samen met de overige add-ondata.

Verwijder de app niet met de optie om alle gegevens te wissen zolang er geen actuele Home Assistant-back-up is. De originele pdf's en serverindex staan in de blijvende add-ondata.
