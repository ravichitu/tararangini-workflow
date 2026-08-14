const SERVICE_GROUPS = [
  {
    key: 'printing',
    label: 'Printing Services',
    description: 'Document printing, colour printing, xerox, scan, and general paper-output work.',
    portal_note: 'Use this for B/W print, colour print, scan, xerox, and document-file jobs.',
    suggested_item_type: 'Document / Print File',
    suggested_summary: 'Printing requirement',
    instruction_hint: 'Pages, print type, size, duplex, copies, binding request, urgency'
  },
  {
    key: 'uv-printing',
    label: 'UV Printing',
    description: 'Custom UV printing on acrylic, board, gifts, plates, and rigid surfaces.',
    portal_note: 'Use this for UV print jobs on acrylic, wood, metal, MDF, gift items, and display materials.',
    suggested_item_type: 'UV Print Material',
    suggested_summary: 'UV printing requirement',
    instruction_hint: 'Material, size, artwork note, quantity, finish, mounting, urgency'
  },
  {
    key: 'binding',
    label: 'Book Binding / Finishing',
    description: 'Binding, lamination, trimming, finishing, and booklet or thesis preparation.',
    portal_note: 'Use this for book binding, thesis work, lamination, cutting, and finishing requests.',
    suggested_item_type: 'Book / Binding Job',
    suggested_summary: 'Binding or finishing requirement',
    instruction_hint: 'Pages, size, binding type, cover, lamination, trimming, delivery urgency'
  },
  {
    key: 'photo-printing',
    label: 'Photo Printing',
    description: 'Photo output, passport photos, album prints, and studio-style print orders.',
    portal_note: 'Use this for photo prints, passport photos, album prints, and image-output jobs.',
    suggested_item_type: 'Photo / Image File',
    suggested_summary: 'Photo printing requirement',
    instruction_hint: 'Print size, paper finish, quantity, colour correction, album or loose prints'
  },
  {
    key: 'photo-frames',
    label: 'Photo Frames',
    description: 'Photo frames, mounted display pieces, framed gifts, and wall-display jobs.',
    portal_note: 'Use this for framing, mounted displays, gift frames, and wall-photo preparation.',
    suggested_item_type: 'Frame / Mounted Display',
    suggested_summary: 'Photo frame requirement',
    instruction_hint: 'Frame size, orientation, photo choice, mount style, glass, wall or table display'
  },
  {
    key: 'computer-service',
    label: 'Computer Shop Services',
    description: 'Laptop, desktop, printer, software, repair, troubleshooting, and device support.',
    portal_note: 'Use this for laptop, desktop, printer, software, internet, repair, and support requests.',
    suggested_item_type: 'Laptop / Desktop / Printer',
    suggested_summary: 'Computer service requirement',
    instruction_hint: 'Device issue, fault, accessories submitted, password note, software request, urgency'
  },
  {
    key: 'other',
    label: 'Other Services',
    description: 'General custom work that does not fit a standard Tarangini service family.',
    portal_note: 'Use this when your job does not clearly match the standard service groups.',
    suggested_item_type: 'Custom Work',
    suggested_summary: 'Custom service requirement',
    instruction_hint: 'Explain the requirement, expected result, size, files, and any special note'
  }
];

function serviceSearchText(service) {
  return [
    service?.category_name,
    service?.subcategory_name,
    service?.name,
    service?.service_snapshot,
    service?.category_snapshot,
    service?.subcategory_snapshot
  ].filter(Boolean).join(' ').toLowerCase();
}

function groupDefinition(key) {
  return SERVICE_GROUPS.find(group => group.key === key) || SERVICE_GROUPS[SERVICE_GROUPS.length - 1];
}

function detectServiceGroup(service) {
  const text = serviceSearchText(service);
  if (text.includes('uv')) return groupDefinition('uv-printing');
  if (text.includes('frame')) return groupDefinition('photo-frames');
  if (text.includes('photo')) return groupDefinition('photo-printing');
  if (
    text.includes('computer') ||
    text.includes('laptop') ||
    text.includes('desktop') ||
    text.includes('repair') ||
    text.includes('support')
  ) return groupDefinition('computer-service');
  if (
    text.includes('bind') ||
    text.includes('finish') ||
    text.includes('laminat') ||
    text.includes('thesis') ||
    text.includes('book')
  ) return groupDefinition('binding');
  if (
    text.includes('print') ||
    text.includes('xerox') ||
    text.includes('scan') ||
    text.includes('copy')
  ) return groupDefinition('printing');
  return groupDefinition('other');
}

function summarizeServiceGroup(service) {
  const group = detectServiceGroup(service);
  return {
    family_key: group.key,
    family_label: group.label,
    family_description: group.description,
    portal_note: group.portal_note,
    suggested_item_type: group.suggested_item_type,
    suggested_summary: group.suggested_summary,
    instruction_hint: group.instruction_hint
  };
}

function groupCatalogServices(services) {
  const grouped = new Map(SERVICE_GROUPS.map(group => [group.key, { ...group, services: [] }]));
  (services || []).forEach(service => {
    const group = detectServiceGroup(service);
    grouped.get(group.key).services.push(service);
  });
  return SERVICE_GROUPS
    .map(group => grouped.get(group.key))
    .filter(group => group.services.length > 0);
}

module.exports = {
  SERVICE_GROUPS,
  summarizeServiceGroup,
  groupCatalogServices
};
