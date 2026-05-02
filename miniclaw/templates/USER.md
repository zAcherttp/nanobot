# User Profile

Information about the user that has been explicitly stated or confirmed.

## Managed Profile
<!-- miniclaw:managed-profile:start -->
```json
{
  "setupComplete": false,
  "name": "",
  "timezone": "",
  "language": "",
  "communicationStyle": "",
  "responseLength": "",
  "technicalLevel": "",
  "calendarProvider": "",
  "defaultCalendar": ""
}
```
<!-- miniclaw:managed-profile:end -->

## Stable Facts
<!-- miniclaw:stable-facts:start -->
```json
[]
```
<!-- miniclaw:stable-facts:end -->

## Preferences
<!-- miniclaw:preferences:start -->
```json
[]
```
<!-- miniclaw:preferences:end -->

## Notes

- The managed profile is updated by tools and should remain valid JSON.
- Keep only explicit confirmed user information here.
- Store workspace and project knowledge in MEMORY.md, not USER.md.
- Store explicit user goals in GOALS.md, not USER.md.
