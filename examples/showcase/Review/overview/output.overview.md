# output

## output

### Author Notes

Keep paragraphs short. Let %heroName% carry the scene.

### Story Cards

#### zz_AIN

##### AI Instructions — Scenario Rules Only
~~~
encapsulate: false
kind: reference
notes: Do not resolve a scene the player opened in the same turn.
~~~
AI Instructions — Scenario Rules Only — copy the description field below into your scenario's AI Instructions.

## output - knight

### AI Instructions

```
Second person, present tense.
Close, unsparing observation. Never make Voss sympathetic.

Do not resolve a scene the player opened in the same turn.

The player's history with Kaiden is unresolved. he does not raise it
unprompted, and his restraint should read as deliberate. Treat
%liName% as %liGender% throughout.
```

### Opening

%heroName% woke with %oath% still ringing, and Voss already gone.

### Plot Essentials

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

{
Opening Hint - Ask about the stacks
}
```

### Story Cards

#### character

##### Felix Grayls
~~~
triggers: [Felix, Grayls]
encapsulate: false
~~~
Felix Grayls - Court Alchemist; guild liaison; sworn to the Academy
Vibe: [precise; guarded; curious]
Appearance: male; mid 20s; silver hair
Personality: precise, guarded

##### Kaiden Ross
~~~
triggers: [Kaiden, Ross]
encapsulate: false
meta:
  duckieConv:
    role: anchor
~~~
Kaiden Ross - Hedge Knight without a house
Vibe: [wry; watchful; steady]
Appearance: male; early 30s; dark, close-cropped
Personality: wry, watchful
Relationships: Rides the northern circuit alone when the roads are bad.

##### Elder Roshan
~~~
triggers: [Roshan, Elder]
encapsulate: false
meta:
  duckieConv:
    role: standard
notes: '[e]'
~~~
Elder Roshan - Master Archivist of the Academy
Vibe: [patient; cryptic; exacting]
Appearance: male; 60s; white beard, bald
Personality: wise, patient, cryptic
Magic: memory; recall of things not witnessed
Background:
- Catalogued the Academy's lower stacks for forty years.
- Never sat the mastery examination.
[Hidden Info: He knows which records were burned, and by whom.]

##### Ilan Voss
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

#### faction

##### The Alchemists' Guild
~~~
triggers: [Guild, Alchemists]
encapsulate: false
kind: reference
~~~
The Alchemists' Guild - Chartered monopoly on refined reagents
The guild predates the academy. It has outlasted three charters.
Purpose: Control the reagent trade
Structure: A masters' council of nine
Status: active

#### location

##### The Royal Academy
~~~
triggers: [Academy, Royal Academy]
encapsulate: false
~~~
The Royal Academy - Seven towers around a frozen courtyard; the wing that admits only sworn houses; under a standing snow
Culture Vibe: [austere; competitive; old]
- The lower stacks
- The frozen courtyard
Pantheon:
- Vashet: keeper of records
- Ilm: patron of oaths

##### The Warrens
~~~
triggers: [Warrens]
encapsulate: false
~~~
The Warrens - Tenements below the Academy wall
Culture Vibe: [crowded; wary; resourceful]
The cistern market

#### zz_AIN

##### AI Instructions — Full
~~~
encapsulate: false
kind: reference
notes: |-
  Second person, present tense.
  Close, unsparing observation. Never make Voss sympathetic.
  
  Do not resolve a scene the player opened in the same turn.
  
  The player's history with Kaiden is unresolved. he does not raise it
  unprompted, and his restraint should read as deliberate. Treat
  %liName% as %liGender% throughout.
~~~
AI Instructions — Full — copy the description field below into your scenario's AI Instructions.

## output - lowContext

### AI Instructions

```
Second person, present tense.
Clinical observation.

Do not resolve a scene the player opened in the same turn.

The player's history with Kaiden is unresolved. he does not raise it
unprompted, and his restraint should read as deliberate. Treat
%liName% as %liGender% throughout.
```

### Opening

%heroName% woke.

### Plot Essentials

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

### Story Cards

#### character

##### Felicia Grayls
~~~
triggers: [Felicia, Grayls]
encapsulate: false
~~~
Felicia Grayls - Court Alchemist; guild liaison
Appearance: female; mid 20s; silver hair, in a controlled bun
Personality: precise, guarded

##### Kaiden Ross
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

##### Elder Roshan
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

##### Ilan Voss
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

#### faction

##### The Alchemists' Guild
~~~
triggers: [Guild, Alchemists]
encapsulate: false
kind: reference
~~~
The Alchemists' Guild - Chartered monopoly on refined reagents
Purpose: Control the reagent trade
Status: active

#### location

##### The Royal Academy
~~~
triggers: [Academy, Royal Academy]
encapsulate: false
~~~
The Royal Academy - Seven towers around a frozen courtyard; the wing that admits only sworn houses; under a standing snow

#### zz_AIN

##### AI Instructions — Full
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

## output - mage

### AI Instructions

```
Second person, present tense.
Clinical observation.

Do not resolve a scene the player opened in the same turn.

The player's history with Felicia is unresolved. she does not raise it
unprompted, and her restraint should read as deliberate. Treat
%liName% as %liGender% throughout.
```

### Opening

%heroName% woke to the smell of chalk dust.

### Plot Essentials

```
[
Genre: Dark Fantasy | Political Intrigue
Setting: Feudal empire; The Royal Academy, %house% wing
]

{
You: %heroName%, Academy Mage
Appearance: female; late 20s; short silver hair; silver staff
Personality: determined, loyal, reserved
You love a clean solution — you act before you explain.
}

{
Elder Roshan - Master Archivist of the Academy
Appearance: male; 60s; white beard, bald
Personality: wise, patient, cryptic
}

{
Opening Hint - Ask about the stacks
}
```

### Story Cards

#### character

##### Felicia Grayls
~~~
triggers: [Felicia, Grayls]
encapsulate: false
~~~
Felicia Grayls - Court Alchemist; guild liaison
Vibe: [precise; guarded; curious]
Appearance: female; mid 20s; silver hair, in a controlled bun
Personality: precise, guarded

##### Kaiden Ross
~~~
triggers: [Kaiden, Ross]
encapsulate: false
meta:
  duckieConv:
    role: anchor
~~~
Kaiden Ross - Hedge Knight without a house
Vibe: [wry; watchful; steady]
Appearance: male; early 30s; dark, close-cropped
Personality: wry, watchful
Relationships: Rides the northern circuit alone when the roads are bad.

##### Elder Roshan
~~~
triggers: [Roshan, Elder]
encapsulate: false
meta:
  duckieConv:
    role: standard
notes: '[e]'
~~~
Elder Roshan - Master Archivist of the Academy
Vibe: [patient; cryptic; exacting]
Appearance: male; 60s; white beard, bald
Personality: wise, patient, cryptic
Magic: memory; recall of things not witnessed
Background:
- Catalogued the Academy's lower stacks for forty years.
- Never sat the mastery examination.
[Hidden Info: He knows which records were burned, and by whom.]

#### faction

##### The Alchemists' Guild
~~~
triggers: [Guild, Alchemists]
encapsulate: false
kind: reference
~~~
The Alchemists' Guild - Chartered monopoly on refined reagents
The guild predates the academy. It has outlasted three charters.
Purpose: Control the reagent trade
Structure: A masters' council of nine
Status: active

#### location

##### The Royal Academy
~~~
triggers: [Academy, Royal Academy]
encapsulate: false
~~~
The Royal Academy - Seven towers around a frozen courtyard; the wing that admits only sworn houses; under a standing snow
Culture Vibe: [austere; competitive; old]
- The lower stacks
- The frozen courtyard
Pantheon:
- Vashet: keeper of records
- Ilm: patron of oaths

##### The Warrens
~~~
triggers: [Warrens]
encapsulate: false
~~~
The Warrens - Tenements below the Academy wall
Culture Vibe: [crowded; wary; resourceful]
The cistern market

#### zz_AIN

##### AI Instructions — Full
~~~
encapsulate: false
kind: reference
notes: |-
  Second person, present tense.
  Clinical observation.
  
  Do not resolve a scene the player opened in the same turn.
  
  The player's history with Felicia is unresolved. she does not raise it
  unprompted, and her restraint should read as deliberate. Treat
  %liName% as %liGender% throughout.
~~~
AI Instructions — Full — copy the description field below into your scenario's AI Instructions.