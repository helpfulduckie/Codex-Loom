# output: lowContext

## Opening

%heroName% woke.

## Plot Essentials

```
[
Genre: Dark Fantasy | Political Intrigue
Setting: Feudal empire; The Royal Academy, %house% wing
]

{
You: %heroName%, Sworn Protector
Appearance: female; late 20s; short silver hair
Personality: determined, loyal, reserved
You love a clean solution — you act before you explain.
}

{
Elder Roshan - Master Archivist of the Academy
Appearance: male; 60s; white beard, bald
Personality: wise, patient, cryptic
}
```

## AI Instructions

```
Second person, present tense.
Clinical observation.

Do not resolve a scene the player opened in the same turn.

The player's history with Kaiden is unresolved. he does not raise it
unprompted, and his restraint should read as deliberate. Treat
%liName% as %liGender% throughout.
```

## Author's Note

Keep paragraphs short. Let %heroName% carry the scene.

## Story Cards

### character

#### Elder Roshan
~~~
triggers: [Roshan, Elder]
encapsulate: false
meta:
  duckieConv:
    role: standard
notes: '[e]'
~~~
Elder Roshan - Master Archivist of the Academy
Appearance: male; 60s; white beard, bald
Personality: wise, patient, cryptic

#### Felicia Grayls
~~~
triggers: [Felicia, Grayls]
encapsulate: false
~~~
Felicia Grayls - Court Alchemist; guild liaison
Appearance: female; mid 20s; silver hair, in a controlled bun
Personality: precise, guarded

#### Ilan Voss
~~~
triggers: [Voss, Ilan]
encapsulate: false
~~~
Ilan Voss - The rival who never conceded
Vibe: [driven; unsentimental; patient]
Appearance: nonbinary; 30s; braided black hair
Personality: driven, unsentimental
Magic: fire; controlled burns
Background: Placed second in every examination Aria placed first in.
[Hidden Info: Voss forged the letter that opened the lower stacks.]

#### Kaiden Ross
~~~
triggers: [Kaiden, Ross]
encapsulate: false
meta:
  duckieConv:
    role: anchor
~~~
Kaiden Ross - Hedge Knight without a house
Appearance: male; early 30s; dark, close-cropped
Personality: wry, watchful

### faction

#### The Alchemists' Guild
~~~
triggers: [Guild, Alchemists]
encapsulate: false
kind: reference
~~~
The Alchemists' Guild - Chartered monopoly on refined reagents
Purpose: Control the reagent trade
Status: active

### location

#### The Royal Academy
~~~
triggers: [Academy, Royal Academy]
encapsulate: false
~~~
The Royal Academy - Seven towers around a frozen courtyard; the wing that admits only sworn houses; under a standing snow

### zz_AIN

#### AI Instructions — Full
~~~
encapsulate: false
kind: reference
notes: |-
  Second person, present tense.
  Clinical observation.
  
  Do not resolve a scene the player opened in the same turn.
  
  The player's history with Kaiden is unresolved. he does not raise it
  unprompted, and his restraint should read as deliberate. Treat
  %liName% as %liGender% throughout.
~~~
AI Instructions — Full — copy the description field below into your scenario's AI Instructions.

#### AI Instructions — Scenario Rules Only
~~~
encapsulate: false
kind: reference
notes: Do not resolve a scene the player opened in the same turn.
~~~
AI Instructions — Scenario Rules Only — copy the description field below into your scenario's AI Instructions.