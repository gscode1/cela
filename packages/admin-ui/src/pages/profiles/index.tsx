import { Route, Routes } from "react-router";
import { NewProfile, ProfileScreen } from "@/pages/profiles/detail";
import { ProfileList } from "@/pages/profiles/list";

/** `/profiles`: the list, `/profiles/new`, and `/profiles/:name`. */
export function Profiles() {
  return (
    <Routes>
      <Route index element={<ProfileList />} />
      <Route path="new" element={<NewProfile />} />
      <Route path=":name" element={<ProfileScreen />} />
    </Routes>
  );
}
