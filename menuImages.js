const MENU_IMAGES = {
  applejuice: "/menu/applejuice.png",
  borscht: "/menu/borscht.png",
  coffee: "/menu/coffee.png",
  pureshka: "/menu/pureshka.png",
};

export const menuImageFor = (dishId) => MENU_IMAGES[dishId] || "/dish-placeholder.svg";
