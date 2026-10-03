import { localeIndex, type Locale } from "./types";

type Translation = readonly [string, string, string];
type AppointmentCategory = {
  service: "health" | "beauty" | "other";
  label: Translation;
  title: Translation;
  request: Translation;
  reason: Translation;
  reasonHelp?: Translation;
  searchAction: Translation;
  finderTitle: Translation;
  businessPlaceholder: Translation;
  businessLabel?: Translation;
  searchTerm: string;
};

// Specialties belong to a service; adding one does not add another service card.
// TODO(dependents): Enable pediatrician (小児科) and veterinarian (動物病院)
// only after profiles/database support multiple children/pets, selecting who the
// appointment is for, and sharing the selected dependent's details together with
// the parent/owner's details in the call brief. Implement in a separate session.
export const appointmentCategories = {
  doctor: {
    service: "health",
    label: ["General practitioner", "Médico general", "総合診療"],
    title: ["Booking a general practice appointment", "Una cita con el médico general", "総合診療の予約"],
    request: ["Book a general practice appointment", "Pedir una cita con el médico general", "総合診療を予約する"],
    reason: ["e.g. General consultation", "Ej. Consulta general", "例：一般的な診察"],
    searchAction: ["Search nearby general practitioners", "Buscar médicos generales cercanos", "近くの総合診療クリニックを探す"],
    finderTitle: ["Find your general practitioner", "Encuentra tu médico general", "総合診療クリニックを探す"],
    businessPlaceholder: ["e.g. Sakura Clinic", "Ej. Clínica Sakura", "例：さくらクリニック"],
    searchTerm: "総合診療 クリニック",
  },
  dentist: {
    service: "health",
    label: ["Dentist", "Dentista", "歯科"],
    title: ["Booking a dentist appointment", "Una cita con el dentista", "歯科の予約"],
    request: ["Book a dentist appointment", "Pedir una cita con el dentista", "歯科を予約する"],
    reason: ["e.g. Dental cleaning", "Ej. Limpieza dental", "例：歯のクリーニング"],
    searchAction: ["Search nearby dentists", "Buscar dentistas cercanos", "近くの歯科医院を探す"],
    finderTitle: ["Find your dentist", "Encuentra tu dentista", "歯科医院を探す"],
    businessPlaceholder: ["e.g. Sakura Dental Clinic", "Ej. Clínica Dental Sakura", "例：さくら歯科医院"],
    searchTerm: "歯科",
  },
  gynecologist: {
    service: "health",
    label: ["Gynecologist", "Ginecólogo", "婦人科"],
    title: ["Booking a gynecologist appointment", "Una cita con el ginecólogo", "婦人科の予約"],
    request: ["Book a gynecologist appointment", "Pedir una cita con el ginecólogo", "婦人科を予約する"],
    reason: ["e.g. Routine gynecological check-up", "Ej. Revisión ginecológica", "例：婦人科の定期検診"],
    searchAction: ["Search nearby gynecologists", "Buscar ginecólogos cercanos", "近くの婦人科を探す"],
    finderTitle: ["Find your gynecologist", "Encuentra tu ginecólogo", "婦人科を探す"],
    businessPlaceholder: ["e.g. Sakura Women’s Clinic", "Ej. Clínica de Ginecología Sakura", "例：さくら婦人科クリニック"],
    searchTerm: "婦人科",
  },
  dermatologist: {
    service: "health",
    label: ["Dermatologist", "Dermatólogo", "皮膚科"],
    title: ["Booking a dermatologist appointment", "Una cita con el dermatólogo", "皮膚科の予約"],
    request: ["Book a dermatologist appointment", "Pedir una cita con el dermatólogo", "皮膚科を予約する"],
    reason: ["e.g. Skin consultation", "Ej. Consulta de la piel", "例：肌の相談"],
    searchAction: ["Search nearby dermatologists", "Buscar dermatólogos cercanos", "近くの皮膚科を探す"],
    finderTitle: ["Find your dermatologist", "Encuentra tu dermatólogo", "皮膚科を探す"],
    businessPlaceholder: ["e.g. Sakura Dermatology Clinic", "Ej. Clínica Dermatológica Sakura", "例：さくら皮膚科"],
    searchTerm: "皮膚科",
  },
  ophthalmologist: {
    service: "health",
    label: ["Ophthalmologist", "Oftalmólogo", "眼科"],
    title: ["Booking an ophthalmologist appointment", "Una cita con el oftalmólogo", "眼科の予約"],
    request: ["Book an ophthalmologist appointment", "Pedir una cita con el oftalmólogo", "眼科を予約する"],
    reason: ["e.g. Eye examination", "Ej. Revisión de la vista", "例：目の検査"],
    searchAction: ["Search nearby ophthalmologists", "Buscar oftalmólogos cercanos", "近くの眼科を探す"],
    finderTitle: ["Find your ophthalmologist", "Encuentra tu oftalmólogo", "眼科を探す"],
    businessPlaceholder: ["e.g. Sakura Eye Clinic", "Ej. Clínica Oftalmológica Sakura", "例：さくら眼科"],
    searchTerm: "眼科",
  },
  ent: {
    service: "health",
    label: ["Ear, nose & throat specialist", "Otorrino", "耳鼻咽喉科"],
    title: ["Booking an ENT appointment", "Una cita con el otorrino", "耳鼻咽喉科の予約"],
    request: ["Book an ear, nose and throat appointment", "Pedir una cita con el otorrino", "耳鼻咽喉科を予約する"],
    reason: ["e.g. Ear examination", "Ej. Revisión del oído", "例：耳の診察"],
    searchAction: ["Search nearby ENT specialists", "Buscar otorrinos cercanos", "近くの耳鼻咽喉科を探す"],
    finderTitle: ["Find your ENT specialist", "Encuentra tu otorrino", "耳鼻咽喉科を探す"],
    businessPlaceholder: ["e.g. Sakura ENT Clinic", "Ej. Clínica de Otorrino Sakura", "例：さくら耳鼻咽喉科"],
    searchTerm: "耳鼻咽喉科",
  },
  hair: {
    service: "beauty",
    label: ["Hair salon", "Peluquería", "美容室"],
    title: ["Booking a hair appointment", "Una cita en la peluquería", "美容室の予約"],
    request: ["Book a hair salon appointment", "Pedir una cita en la peluquería", "美容室を予約する"],
    reason: ["e.g. Haircut", "Ej. Corte de pelo", "例：ヘアカット"],
    searchAction: ["Search nearby hair salons", "Buscar peluquerías cercanas", "近くの美容室を探す"],
    finderTitle: ["Find your hair salon", "Encuentra tu peluquería", "美容室を探す"],
    businessLabel: ["Hair salon name", "Nombre de la peluquería", "美容室名"],
    businessPlaceholder: ["e.g. Sakura Hair Salon", "Ej. Peluquería Sakura", "例：さくら美容室"],
    searchTerm: "美容院",
  },
  nails: {
    service: "beauty",
    label: ["Nail salon", "Salón de uñas", "ネイルサロン"],
    title: ["Booking a nail salon appointment", "Una cita en el salón de uñas", "ネイルサロンの予約"],
    request: ["Book a nail salon appointment", "Pedir una cita en el salón de uñas", "ネイルサロンを予約する"],
    reason: ["e.g. Manicure", "Ej. Manicura", "例：ネイルケア"],
    searchAction: ["Search nearby nail salons", "Buscar salones de uñas cercanos", "近くのネイルサロンを探す"],
    finderTitle: ["Find your nail salon", "Encuentra tu salón de uñas", "ネイルサロンを探す"],
    businessLabel: ["Nail salon name", "Nombre del salón de uñas", "ネイルサロン名"],
    businessPlaceholder: ["e.g. Sakura Nail Salon", "Ej. Salón de Uñas Sakura", "例：さくらネイルサロン"],
    searchTerm: "ネイルサロン",
  },
  massage: {
    service: "beauty",
    label: ["Relaxation massage", "Masaje relajante", "リラクゼーションマッサージ"],
    title: ["Booking a relaxation massage", "Una cita de masaje relajante", "リラクゼーションマッサージの予約"],
    request: ["Book a relaxation massage appointment", "Pedir una cita de masaje relajante", "リラクゼーションマッサージを予約する"],
    reason: ["e.g. Relaxation massage", "Ej. Masaje relajante", "例：リラクゼーションマッサージ"],
    searchAction: ["Search nearby relaxation massage centers", "Buscar centros de masaje relajante cercanos", "近くのリラクゼーションマッサージ店を探す"],
    finderTitle: ["Find your relaxation massage center", "Encuentra tu centro de masaje relajante", "リラクゼーションマッサージ店を探す"],
    businessLabel: ["Massage center name", "Nombre del centro de masajes", "マッサージ店名"],
    businessPlaceholder: ["e.g. Sakura Relaxation", "Ej. Centro de Masajes Sakura", "例：さくらリラクゼーション"],
    searchTerm: "リラクゼーション マッサージ",
  },
  esthetics: {
    service: "beauty",
    label: ["Facial treatments", "Estética facial", "フェイシャルエステ"],
    title: ["Booking a facial treatment", "Una cita de estética facial", "フェイシャルエステの予約"],
    request: ["Book a facial treatment appointment", "Pedir una cita de estética facial", "フェイシャルエステを予約する"],
    reason: ["e.g. Facial cleansing", "Ej. Limpieza facial", "例：フェイシャルクレンジング"],
    searchAction: ["Search nearby facial treatment salons", "Buscar centros de estética facial cercanos", "近くのフェイシャルエステサロンを探す"],
    finderTitle: ["Find your facial treatment salon", "Encuentra tu centro de estética facial", "フェイシャルエステサロンを探す"],
    businessLabel: ["Facial treatment salon name", "Nombre del centro de estética facial", "フェイシャルエステサロン名"],
    businessPlaceholder: ["e.g. Sakura Facial Salon", "Ej. Centro de Estética Facial Sakura", "例：さくらフェイシャルサロン"],
    searchTerm: "フェイシャルエステ サロン",
  },
  beauty: {
    service: "beauty",
    label: ["Other personal care", "Otro cuidado personal", "その他のセルフケア"],
    title: ["Booking a personal care appointment", "Tu cita de cuidado personal", "セルフケアの予約"],
    request: ["Book a personal care appointment", "Pedir una cita de cuidado personal", "セルフケアの予約をする"],
    reason: ["e.g. Hair removal", "Ej. Depilación", "例：脱毛"],
    reasonHelp: ["Tell us the specific service you need. In the map search, enter that service or a business name.", "Indica el servicio concreto. Al buscar en el mapa, escribe ese servicio o el nombre del negocio.", "希望するサービスを具体的に入力してください。地図検索ではそのサービスまたは施設名を入力します。"],
    searchAction: ["Search for a personal care service", "Buscar un servicio de cuidado personal", "セルフケアの施設を探す"],
    finderTitle: ["Find your personal care service", "Encuentra tu servicio de cuidado personal", "セルフケアの施設を探す"],
    businessPlaceholder: ["Enter the center or business name", "Escribe el nombre del centro o negocio", "施設名を入力"],
    searchTerm: "",
  },
  auto_service: {
    service: "other",
    label: ["Auto service", "Taller mecánico", "自動車整備"],
    title: ["Booking an auto service", "Una cita en el taller", "自動車整備の予約"],
    request: ["Book an auto service appointment", "Pedir una cita en el taller mecánico", "自動車整備を予約する"],
    reason: ["e.g. Oil change", "Ej. Cambio de aceite", "例：オイル交換"],
    reasonHelp: ["Include the service and, if known, your car’s make and model.", "Indica el servicio y, si los sabes, la marca y el modelo de tu coche.", "希望する作業と、わかれば車のメーカー・車種を入力してください。"],
    searchAction: ["Search nearby auto workshops", "Buscar talleres cercanos", "近くの自動車整備工場を探す"],
    finderTitle: ["Find your auto workshop", "Encuentra tu taller", "自動車整備工場を探す"],
    businessLabel: ["Workshop name", "Nombre del taller", "整備工場名"],
    businessPlaceholder: ["e.g. Sakura Auto Service", "Ej. Taller Sakura", "例：さくら自動車整備"],
    searchTerm: "自動車整備工場",
  },
  professional: {
    service: "other",
    label: ["Tax advisor", "Asesor fiscal", "税理士"],
    title: ["Booking a tax consultation", "Una cita con el asesor fiscal", "税理士への相談予約"],
    request: ["Book a tax consultation", "Pedir una cita con el asesor fiscal", "税理士への相談を予約する"],
    reason: ["e.g. Tax return consultation", "Ej. Consulta sobre mi declaración de impuestos", "例：確定申告の相談"],
    searchAction: ["Search nearby tax advisors", "Buscar asesores fiscales cercanos", "近くの税理士を探す"],
    finderTitle: ["Find your tax advisor", "Encuentra tu asesor fiscal", "税理士を探す"],
    businessLabel: ["Tax advisor or office name", "Nombre del asesor fiscal o despacho", "税理士・事務所の名前"],
    businessPlaceholder: ["e.g. Sakura Tax Office", "Ej. Asesoría Fiscal Sakura", "例：さくら税理士事務所"],
    searchTerm: "税理士",
  },
  other: {
    service: "other",
    label: ["Another service", "Otro servicio", "その他のサービス"],
    title: ["Booking your appointment", "Tu próxima cita", "次の予約"],
    request: ["Book an appointment", "Pedir una cita", "予約をする"],
    reason: ["e.g. An initial consultation with a lawyer", "Ej. Una primera consulta con un abogado", "例：弁護士への初回相談"],
    reasonHelp: ["Specify the service and the reason for your appointment. In the map search, enter the service or a business name.", "Especifica el servicio y el motivo de la cita. Al buscar en el mapa, escribe el servicio o el nombre del negocio.", "サービスの種類と予約の目的を入力してください。地図検索ではサービスまたは施設名を入力します。"],
    searchAction: ["Search for a place", "Buscar un lugar", "場所を検索"],
    finderTitle: ["Find a place", "Encuentra un lugar", "場所を探す"],
    businessPlaceholder: ["Enter the business or contact name", "Escribe el nombre del negocio o contacto", "施設名・連絡先の名前を入力"],
    searchTerm: "",
  },
} as const satisfies Record<string, AppointmentCategory>;

export function appointmentCategoryCopy(category: string, locale: Locale) {
  if (!Object.hasOwn(appointmentCategories, category)) return;
  const item: AppointmentCategory = appointmentCategories[category as keyof typeof appointmentCategories];
  const i = localeIndex(locale);
  return {
    service: item.service,
    label: item.label[i],
    title: item.title[i],
    request: item.request[i],
    reason: item.reason[i],
    reasonHelp: item.reasonHelp?.[i],
    searchAction: item.searchAction[i],
    finderTitle: item.finderTitle[i],
    businessPlaceholder: item.businessPlaceholder[i],
    businessLabel: (item.businessLabel ||
      (item.service === "health"
        ? ["Clinic name", "Nombre de la clínica", "医療機関名"]
        : item.service === "beauty"
          ? ["Salon or wellness center name", "Nombre del salón o centro de bienestar", "サロン・ウェルネス施設名"]
          : ["Business or contact name", "Nombre del negocio o contacto", "施設・連絡先の名前"]))[i],
    customerLabel: (item.service === "health"
        ? ["I’ve been here before", "Ya me he atendido aquí", "受診・利用歴があります"]
        : ["I’ve used this service before", "Ya he usado este servicio", "このサービスを利用したことがあります"])[i],
    searchTerm: item.searchTerm,
  };
}
