# Wijzigingen

## 1.4.1

- Herstelt de ARM64- en AMD64-containerbuild zodat altijd de volledige DienstenLezer-server wordt gepubliceerd.
- Gepubliceerde containers worden voortaan daadwerkelijk gestart en via `/api/health` gecontroleerd voordat het Home Assistant-image wordt vrijgegeven.

## 1.4.0

- Accounts met gebruikers- en adminrollen, langdurige sessies en servergecontroleerde beheertoegang toegevoegd.
- Gereden diensten kunnen worden bevestigd, gecorrigeerd, geexporteerd en worden gebruikt voor persoonlijke statistieken.
- Achievements ondersteunen voortgang, samengestelde voorwaarden, divisies, voorwaarden per dienst en opeenvolgende diensten.
- Lijn-, pauze- en materieelminuten worden uit de bevestigde diensthistorie berekend.
- Dienstbegeleiding en overname-informatie zijn consistenter gemaakt en bevestigde-dienstmeldingen verdwijnen direct.
- Gesplitste ritdelen worden visueel als een geheel behandeld zonder hun werkelijke tijdsafstand te verliezen.
- Vertraging bij een omloop staat nu op alle schermformaten onder het actuele busnummer.
- De ongebruikte Windows-executablelaag is verwijderd; lokale ontwikkeling, webserver en Home Assistant blijven behouden.

## 1.3.4

- Pdf-bestanden kunnen per divisie worden ingedeeld en divisies kunnen centraal onder concessies worden gegroepeerd.
- Elke client kan zelfstandig een of meerdere divisies voor de overzichten selecteren.
- Busloze chauffeursacties zijn centraal instelbaar en worden niet meer onterecht aan de vorige omloop gekoppeld.
- Afwijkende dienstbladen met een extra OV-chipkolom worden correct weergegeven.
- Instellingen zijn verdeeld over duidelijke tabs; het volledige bestandenbeheer staat nu onder Instellingen.
- Dienstbegeleiding begint na de operationele daggrens van 04:00 opnieuw bij het begin van de dienst.

## 1.3.3

- Ritdelen die door een chauffeurswissel zijn gesplitst worden in het omloopoverzicht als een herkenbaar geheel weergegeven.
- Dienstbegeleiding toont opnieuw een overname wanneer een andere chauffeur tijdens de pauze met dezelfde omloop heeft gereden.
- Overnameblokken tonen geen status of geschatte aankomst zolang daarvoor geen livegegevens beschikbaar zijn.

## 1.3.2

- Livegegevens worden sneller gekoppeld en blijven kort lokaal beschikbaar na herladen.
- De interface toont wanneer OVapi wordt ververst en waarschuwt bij verouderde gegevens.
- Busnummers openen de bijbehorende voertuigpagina op Busposities.nl.
- Ritdetails onderscheiden directe live-voertuignummers van afgeleide omlopinformatie.
- De live-status in Dienstbegeleiding is op mobiele schermen compacter gemaakt.

## 1.3.1

- Open Web UI werkt via Home Assistant Ingress, ook via een externe Home Assistant-verbinding.
- Directe toegang via poort 8080 blijft beschikbaar.
- Home Assistant-images bouwen parallel op native AMD64 en ARM64 met een herbruikbare dependencycache.

## 1.3.0

- Eerste Home Assistant-proefversie.
- ARM64- en AMD64-ondersteuning.
- Blijvende pdf-bank en Qbuzz-cache in `/data`.
