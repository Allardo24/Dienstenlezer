// Algemene clientinstellingen. Na wijzigen opnieuw bouwen/publiceren.
// Tijdseenheden staan in de namen; gebruik positieve getallen.
export const appConfig = {
  takeover: {
    // Toon de melding vanaf dit aantal minuten voor de geplande vertrektijd.
    alertBeforeDepartureMinutes: 15,
    // Afwijkingen tot en met deze grens vallen onder 'op tijd'.
    delayThresholdSeconds: 60,
    // Bij vertraging en meer overstaptijd dan dit blijft de bovenste melding weg.
    sufficientTransferMinutes: 7,
    // Maximale afwijking van een aankomstvoorspelling t.o.v. planning + vertraging.
    arrivalPredictionToleranceMinutes: 15,
    plannedArrivalToleranceMinutes: 1.5,
  },
  live: {
    // Wachttijd NA een afgeronde aanvraag; servercache en feedtempo zijn apart.
    refreshIntervalSeconds: 30,
    staleAfterSeconds: 90,
    // Maximale leeftijd van lokaal bewaarde livegegevens bij opnieuw openen.
    browserCacheHours: 24,
  },
  timeline: {
    // Beginweergave; de gebruiker kan het aantal uren nog zelf aanpassen.
    defaultHours: 6,
    desktopLoopColumnWidth: 170,
    mobileLoopColumnWidth: 84,
  },
  account: {
    // Positief geheel getal.
    dutiesPerPage: 5,
  },
};
