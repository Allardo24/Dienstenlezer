# Migratie naar Home Assistant OS

Deze migratie laat de huidige Windows-server bewust intact totdat de Home Assistant-versie is gecontroleerd.

## Fase 1: lokaal proefpakket

Maak op de ontwikkelcomputer het pakket:

```powershell
npm run ha:addon:package
npm run ha:addon:check
```

Het resultaat staat in `artifacts/home-assistant/dienstenlezer`. Het bestand `artifacts/dienstenlezer-home-assistant.tar.gz` bevat dezelfde map in overdraagbare vorm.

1. Installeer in Home Assistant tijdelijk de app **Advanced SSH & Web Terminal** of gebruik de Samba-app.
2. Zet de map `dienstenlezer` onder `/addons/` op Home Assistant OS.
3. Ga naar **Instellingen > Apps > Appwinkel** en kies **Controleren op updates**.
4. Open de lokale app **DienstenLezer** en kies **Installeren**.
5. De eerste lokale bouw op een Raspberry Pi kan geruime tijd duren. Laat Home Assistant aan de stroom en onderbreek de installatie niet.
6. Start de app en controleer `http://<ip-van-home-assistant>:8080/api/health`.

Verander de Cloudflare Tunnel in deze fase nog niet.

## Fase 2: functionele controle

1. Open de webinterface op het lokale Home Assistant-adres.
2. Voeg een kleine representatieve set pdf's toe.
3. Controleer het omloopoverzicht, dienstenoverzicht en dienstbegeleiding.
4. Zet livegegevens aan en wacht de eerste GTFS-indexering af.
5. Herstart alleen de DienstenLezer-app en controleer of bestanden en cache bewaard zijn.
6. Maak een volledige Home Assistant-back-up en controleer dat DienstenLezer daarin vermeld staat.

De interface komt uit exact dezelfde Vite-build als de Windows- en webversie.

## Fase 3: bestaande gegevens

De huidige Windows-map `server-data` bevat zowel de pdf-bank als een grote, opnieuw op te bouwen GTFS-cache. Kopieer die map niet blind naar het installatie-image.

De veilige eerste migratie is:

1. Upload de actieve pdf's opnieuw via de bestandenpagina van de Home Assistant-versie.
2. Laat Qbuzz-live de GTFS-cache eenmalig opnieuw opbouwen.
3. Controleer de aantallen bestanden, diensten en ritregels.

Een directe gegevensimport kan later worden toegevoegd als het opnieuw uploaden te veel werk blijkt.

## Fase 4: domein omzetten

Pas wanneer de lokale versie stabiel werkt:

1. Wijzig in Cloudflared de aanvullende host voor DienstenLezer naar `http://<ip-van-home-assistant>:8080`.
2. Herstart Cloudflared.
3. Controleer de website via mobiele data.
4. Laat de Windows-server nog enkele dagen beschikbaar, maar niet tegelijk achter hetzelfde domein.

## Terugrollen

Werkt de Home Assistant-versie niet goed, zet dan alleen de Cloudflared-host terug naar `http://192.168.68.130:8080` en start de Windows-server. De Windows-data is tijdens de proef niet aangepast of verwijderd.

## Vooraf gebouwde updates

De workflow `.github/workflows/publish-ha-image.yml` bouwt later automatisch `aarch64` en `amd64` voor GitHub Container Registry. Daarvoor is een GitHub-repository nodig.

Na het aanmaken van die repository:

1. Publiceer een tag zoals `ha-v1.3.0` of start de workflow handmatig.
2. Maak het pakket opnieuw met `HA_ADDON_IMAGE=ghcr.io/<github-naam>/dienstenlezer`.
3. Publiceer de gegenereerde Home Assistant-repository.
4. Maak het GHCR-package openbaar, zodat Home Assistant zonder inlogtoken updates kan ophalen.

Daarna downloadt de Pi alleen een vooraf gebouwde ARM64-container en hoeft hij niet opnieuw te compileren.
